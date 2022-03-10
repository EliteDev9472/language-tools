import type { EmbeddedDocumentSourceMap } from '@volar/vue-typescript';
import * as vscode from 'vscode-languageserver-protocol';
import { isTsDocument } from '../plugins/typescript';
import type { LanguageServiceRuntimeContext } from '../types';
import * as dedupe from '../utils/dedupe';
import { languageFeatureWorker } from '../utils/featureWorkers';

export function register(context: LanguageServiceRuntimeContext, updateTemplateScripts: () => void) {

	const responseCache = new Map<
		string,
		{
			nonTs: vscode.Diagnostic[],
			templateTs_semantic: vscode.Diagnostic[],
			templateTs_syntactic: vscode.Diagnostic[],
			templateTs_suggestion: vscode.Diagnostic[],
			scriptTs_semantic: vscode.Diagnostic[],
			scriptTs_syntactic: vscode.Diagnostic[],
			scriptTs_suggestion: vscode.Diagnostic[],
		}
	>();
	const nonTsCache = new Map<
		number,
		Map<
			string,
			{
				documentVersion: number,
				tsProjectVersion: string | undefined,
				errors: vscode.Diagnostic[] | undefined | null,
			}
		>
	>();
	const templateTsCache_semantic: typeof nonTsCache = new Map();
	const templateTsCache_syntactic: typeof nonTsCache = new Map();
	const templateTsCache_suggestion: typeof nonTsCache = new Map();
	const scriptTsCache_semantic: typeof nonTsCache = new Map();
	const scriptTsCache_syntactic: typeof nonTsCache = new Map();
	const scriptTsCache_suggestion: typeof nonTsCache = new Map();

	return async (uri: string, response?: (result: vscode.Diagnostic[]) => void, isCancel?: () => Promise<boolean>) => {

		const cache = responseCache.get(uri) ?? responseCache.set(uri, {
			nonTs: [],
			templateTs_semantic: [],
			templateTs_suggestion: [],
			templateTs_syntactic: [],
			scriptTs_semantic: [],
			scriptTs_suggestion: [],
			scriptTs_syntactic: [],
		}).get(uri)!;

		let errorsDirty = false; // avoid cache error range jitter

		cache.nonTs = await worker('nonTs', {
			declaration: true,
			semantic: true,
			suggestion: true,
			syntactic: true,
		}, nonTsCache) ?? [];
		doResponse();

		const vueDocument = context.vueDocuments.get(uri);

		if (vueDocument) {

			const lastUpdated = vueDocument.getLastUpdated();

			const isScriptChanged = lastUpdated.script || lastUpdated.scriptSetup;
			if (isScriptChanged) {
				await scriptWorker();
				doResponse();
				await templateWorker();
			}
			else {
				await templateWorker();
				doResponse();
				await scriptWorker();
			}
		}
		else {
			await scriptWorker();
			doResponse();
			await templateWorker();
		}

		return getErrors();

		function doResponse() {
			if (errorsDirty) {
				response?.(getErrors());
				errorsDirty = false;
			}
		}

		async function templateWorker() {

			cache.templateTs_syntactic = await worker('template', { syntactic: true }, templateTsCache_syntactic) ?? [];
			cache.templateTs_suggestion = await worker('template', { suggestion: true }, templateTsCache_suggestion) ?? [];
			doResponse();
			if (!await isCancel?.())
				updateTemplateScripts();
			cache.templateTs_semantic = await worker('template', { semantic: true }, templateTsCache_semantic) ?? [];
		}

		async function scriptWorker() {
			cache.scriptTs_syntactic = await worker('script', { syntactic: true }, scriptTsCache_syntactic) ?? [];
			cache.scriptTs_suggestion = await worker('script', { suggestion: true }, scriptTsCache_suggestion) ?? [];
			doResponse();
			cache.scriptTs_semantic = await worker('script', { semantic: true }, scriptTsCache_semantic) ?? [];
		}

		function getErrors() {
			return [
				...cache.nonTs,
				...cache.templateTs_syntactic,
				...cache.templateTs_suggestion,
				...cache.templateTs_semantic,
				...cache.scriptTs_syntactic,
				...cache.scriptTs_suggestion,
				...cache.scriptTs_semantic,
			];
		}

		function worker(
			lsType: 'script' | 'template' | 'nonTs',
			options: {
				declaration?: boolean,
				semantic?: boolean,
				suggestion?: boolean,
				syntactic?: boolean,
			},
			cacheMap: typeof nonTsCache,
		) {
			return languageFeatureWorker(
				context,
				uri,
				true,
				function* (arg, sourceMap) {
					if (sourceMap.capabilities.diagnostics && sourceMap.lsType === lsType) {
						yield arg;
					}
				},
				async (plugin, document, arg, sourceMap) => {

					// avoid duplicate errors from vue plugiin
					if (!isTsDocument(document) && !options.semantic)
						return;

					if (await isCancel?.())
						return;

					const _lsType = sourceMap?.lsType ?? 'script';

					if (lsType !== _lsType)
						return;

					const pluginCache = cacheMap.get(plugin.id) ?? cacheMap.set(plugin.id, new Map()).get(plugin.id)!;
					const cache = pluginCache.get(document.uri);
					const tsProjectVersion = _lsType === 'nonTs' ? undefined : context.getTsLs(_lsType).__internal__.host.getProjectVersion?.();

					if (_lsType === 'nonTs') {
						if (cache && cache.documentVersion === document.version) {
							return cache.errors;
						}
					}
					else {
						if (options.declaration || options.semantic) {
							if (cache && cache.documentVersion === document.version && cache.tsProjectVersion === tsProjectVersion) {
								return cache.errors;
							}
						}
						else {
							if (cache && cache.documentVersion === document.version) {
								return cache.errors;
							}
						}
					}

					const errors = await plugin.doValidation?.(document, options);

					errorsDirty = true;

					pluginCache.set(document.uri, {
						documentVersion: document.version,
						errors,
						tsProjectVersion,
					});

					return errors;
				},
				(errors, sourceMap) => transformErrorRange(sourceMap, errors),
				arr => dedupe.withDiagnostics(arr.flat()),
			);
		}
	};

	function transformErrorRange(sourceMap: EmbeddedDocumentSourceMap | undefined, errors: vscode.Diagnostic[]) {

		const result: vscode.Diagnostic[] = [];

		for (const error of errors) {

			const _error: vscode.Diagnostic = { ...error };

			if (sourceMap) {

				const sourceRange = sourceMap.getSourceRange(error.range.start, error.range.end)?.[0];

				if (!sourceRange)
					continue;

				_error.range = sourceRange;
			}

			if (_error.relatedInformation) {

				const relatedInfos: vscode.DiagnosticRelatedInformation[] = [];

				for (const info of _error.relatedInformation) {
					for (const sourceLoc of context.vueDocuments.fromEmbeddedLocation(
						sourceMap?.lsType ?? 'script',
						info.location.uri,
						info.location.range.start,
						info.location.range.end,
						data => !!data.capabilities.diagnostic,
					)) {
						relatedInfos.push({
							location: {
								uri: sourceLoc.uri,
								range: sourceLoc.range,
							},
							message: info.message,
						});
						break;
					}
				}

				_error.relatedInformation = relatedInfos;
			}

			result.push(_error);
		}

		return result;
	}
}
