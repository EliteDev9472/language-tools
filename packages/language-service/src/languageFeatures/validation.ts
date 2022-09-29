import { EmbeddedFileKind } from '@volar/language-core';
import * as shared from '@volar/shared';
import type * as ts from 'typescript/lib/tsserverlibrary';
import * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { EmbeddedDocumentSourceMap } from '../documents';
import type { LanguageServiceRuntimeContext } from '../types';
import * as dedupe from '../utils/dedupe';
import { languageFeatureWorker } from '../utils/featureWorkers';

function isTsDocument(document: TextDocument) {
	return document.languageId === 'javascript' ||
		document.languageId === 'typescript' ||
		document.languageId === 'javascriptreact' ||
		document.languageId === 'typescriptreact';
}

export function updateRange(
	range: vscode.Range,
	change: {
		range: vscode.Range,
		newEnd: vscode.Position;
	},
) {
	updatePosition(range.start, change, false);
	updatePosition(range.end, change, true);
	if (range.end.line === range.start.line && range.end.character <= range.start.character) {
		range.end.character++;
	}
	return range;
}

function updatePosition(
	position: vscode.Position,
	change: {
		range: vscode.Range,
		newEnd: vscode.Position;
	},
	isEnd: boolean,
) {
	if (change.range.end.line > position.line) {
		if (change.newEnd.line > position.line) {
			// No change
		}
		else if (change.newEnd.line === position.line) {
			position.character = Math.min(position.character, change.newEnd.character);
		}
		else if (change.newEnd.line < position.line) {
			position.line = change.newEnd.line;
			position.character = change.newEnd.character;
		}
	}
	else if (change.range.end.line === position.line) {
		const characterDiff = change.newEnd.character - change.range.end.character;
		if (position.character >= change.range.end.character) {
			if (change.newEnd.line !== change.range.end.line) {
				position.line = change.newEnd.line;
				position.character = change.newEnd.character + position.character - change.range.end.character;
			}
			else {
				if (isEnd ? change.range.end.character < position.character : change.range.end.character <= position.character) {
					position.character += characterDiff;
				}
				else {
					const offset = change.range.end.character - position.character;
					if (-characterDiff > offset) {
						position.character += characterDiff + offset;
					}
				}
			}
		}
		else {
			if (change.newEnd.line !== change.range.end.line) {
				if (change.newEnd.line < change.range.end.line) {
					position.line = change.newEnd.line;
					position.character = change.newEnd.character;
				}
			}
			else {
				const offset = change.range.end.character - position.character;
				if (-characterDiff > offset) {
					position.character += characterDiff + offset;
				}
			}
		}
	}
	else if (change.range.end.line < position.line) {
		position.line += change.newEnd.line - change.range.end.line;
	}
}

export function register(context: LanguageServiceRuntimeContext) {

	interface Cache {
		snapshot: ts.IScriptSnapshot | undefined;
		errors: vscode.Diagnostic[];
	}
	const responseCache = new Map<
		string,
		{ [key in 'nonTs' | 'tsSemantic' | 'tsDeclaration' | 'tsSyntactic' | 'tsSuggestion']: Cache }
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
	const scriptTsCache_semantic: typeof nonTsCache = new Map();
	const scriptTsCache_declaration: typeof nonTsCache = new Map();
	const scriptTsCache_syntactic: typeof nonTsCache = new Map();
	const scriptTsCache_suggestion: typeof nonTsCache = new Map();

	return async (uri: string, response?: (result: vscode.Diagnostic[]) => void, cancellationToken?: vscode.CancellationToken) => {

		const cache = responseCache.get(uri) ?? responseCache.set(uri, {
			nonTs: { snapshot: undefined, errors: [] },
			tsSemantic: { snapshot: undefined, errors: [] },
			tsDeclaration: { snapshot: undefined, errors: [] },
			tsSuggestion: { snapshot: undefined, errors: [] },
			tsSyntactic: { snapshot: undefined, errors: [] },
		}).get(uri)!;
		const newSnapshot = context.host.getScriptSnapshot(shared.getPathOfUri(uri));
		const newDocument = newSnapshot ? TextDocument.create('file://a.txt', 'txt', 0, newSnapshot.getText(0, newSnapshot.getLength())) : undefined;

		for (const _cache of Object.values(cache)) {

			const oldSnapshot = _cache.snapshot;
			const change = oldSnapshot ? newSnapshot?.getChangeRange(oldSnapshot) : undefined;

			_cache.snapshot = newSnapshot;

			if (newDocument && oldSnapshot && newSnapshot && change) {
				const oldDocument = TextDocument.create('file://a.txt', 'txt', 0, oldSnapshot.getText(0, oldSnapshot.getLength()));
				const changeRange = {
					range: {
						start: oldDocument.positionAt(change.span.start),
						end: oldDocument.positionAt(change.span.start + change.span.length),
					},
					newEnd: newDocument.positionAt(change.span.start + change.newLength),
				};
				for (const error of _cache.errors) {
					updateRange(error.range, changeRange);
				}
			}
		}

		let shouldSend = false;
		let lastCheckCancelAt = 0;

		await worker(EmbeddedFileKind.TextFile, 'onFull', nonTsCache, cache.nonTs);
		doResponse();
		await worker(EmbeddedFileKind.TypeScriptHostFile, 'onSyntactic', scriptTsCache_syntactic, cache.tsSyntactic);
		doResponse();
		await worker(EmbeddedFileKind.TypeScriptHostFile, 'onSuggestion', scriptTsCache_suggestion, cache.tsSuggestion);
		doResponse();
		await worker(EmbeddedFileKind.TypeScriptHostFile, 'onSemantic', scriptTsCache_semantic, cache.tsSemantic);
		doResponse();
		await worker(EmbeddedFileKind.TypeScriptHostFile, 'onDeclaration', scriptTsCache_declaration, cache.tsDeclaration);

		return getErrors();

		function doResponse() {
			if (shouldSend) {
				response?.(getErrors());
				shouldSend = false;
			}
		}

		function getErrors() {
			return Object.values(cache).flatMap(({ errors }) => errors);
		}

		async function worker(
			kind: EmbeddedFileKind,
			mode: 'onFull' | 'onSemantic' | 'onSyntactic' | 'onSuggestion' | 'onDeclaration',
			cacheMap: typeof nonTsCache,
			cache: Cache,
		) {
			const result = await languageFeatureWorker(
				context,
				uri,
				true,
				function* (arg, sourceMap) {
					if (sourceMap.embeddedFile.capabilities.diagnostic && sourceMap.embeddedFile.kind === kind) {
						yield arg;
					}
				},
				async (plugin, document, arg, sourceMap) => {

					if (cancellationToken) {

						if (Date.now() - lastCheckCancelAt >= 5) {
							await shared.sleep(5); // wait for LSP event polling
							lastCheckCancelAt = Date.now();
						}

						if (cancellationToken.isCancellationRequested)
							return;
					}

					// avoid duplicate errors from vue plugin & typescript plugin
					if (isTsDocument(document) !== (kind === EmbeddedFileKind.TypeScriptHostFile))
						return;

					const pluginId = context.plugins.indexOf(plugin);
					const pluginCache = cacheMap.get(pluginId) ?? cacheMap.set(pluginId, new Map()).get(pluginId)!;
					const cache = pluginCache.get(document.uri);
					const tsProjectVersion = kind === EmbeddedFileKind.TypeScriptHostFile ? context.core.typescriptLanguageServiceHost.getProjectVersion?.() : undefined;

					if (kind !== EmbeddedFileKind.TypeScriptHostFile) {
						if (cache && cache.documentVersion === document.version) {
							return cache.errors;
						}
					}
					else {
						if (mode === 'onFull' || mode === 'onDeclaration' || mode === 'onSemantic') {
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

					const errors = await plugin.validation?.[mode]?.(document);

					shouldSend = true;

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

			if (result) {
				cache.errors = result;
				cache.snapshot = newSnapshot;
			}
		}
	};

	function transformErrorRange(sourceMap: EmbeddedDocumentSourceMap | undefined, errors: vscode.Diagnostic[]) {

		const result: vscode.Diagnostic[] = [];

		for (const error of errors) {

			const _error: vscode.Diagnostic = { ...error };

			if (sourceMap) {
				let range: vscode.Range | undefined;
				for (const start of sourceMap.toSourcePositions(error.range.start)) {
					if (start[1].data.diagnostic) {
						const end = sourceMap.matchSourcePosition(error.range.end, start[1], 'right');
						if (end) {
							range = { start: start[0], end: end };
						}
						else {
							for (const end of sourceMap.toSourcePositions(error.range.end)) {
								if (start[1].data.diagnostic) {
									range = { start: start[0], end: end[0] };
									break;
								}
							}
						}
						break;
					}
				}
				if (!range) {
					continue;
				}
				_error.range = range;
			}

			if (_error.relatedInformation) {

				const relatedInfos: vscode.DiagnosticRelatedInformation[] = [];

				for (const info of _error.relatedInformation) {
					for (const mapped of context.documents.fromEmbeddedLocation(info.location.uri, info.location.range.start)) {

						if (mapped.mapping && !mapped.mapping.data.diagnostic)
							continue;

						const end = mapped.sourceMap ? mapped.sourceMap.toSourcePosition(info.location.range.end)?.[0] : info.location.range.end;
						if (!end)
							continue;

						relatedInfos.push({
							location: {
								uri: mapped.uri,
								range: { start: mapped.position, end },
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
