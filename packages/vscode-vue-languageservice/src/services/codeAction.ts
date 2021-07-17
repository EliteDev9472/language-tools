import { transformLocations } from '@volar/transforms';
import { WorkspaceEdit } from 'vscode-languageserver-types';
import type { CodeAction, CodeActionContext } from 'vscode-languageserver/node';
import { CodeActionKind, Range, TextDocumentEdit } from 'vscode-languageserver/node';
import type { ApiLanguageServiceContext } from '../types';
import * as dedupe from '../utils/dedupe';
import { tsEditToVueEdit } from './rename';
import type { Data } from './callHierarchy';

export function register({ sourceFiles, getCssLs, getTsLs }: ApiLanguageServiceContext) {

	return async (uri: string, range: Range, context: CodeActionContext) => {

		const tsResult = await onTs(uri, range, context);
		const cssResult = onCss(uri, range, context);

		return dedupe.withCodeAction([
			...tsResult,
			...cssResult,
		]);
	}

	async function onTs(uri: string, range: Range, context: CodeActionContext) {

		let result: CodeAction[] = [];

		for (const tsLoc of sourceFiles.toTsLocations(uri, range.start, range.end)) {

			const tsLs = getTsLs(tsLoc.lsType);
			const tsContext: CodeActionContext = {
				diagnostics: transformLocations(
					context.diagnostics,
					vueRange => tsLoc.type === 'embedded-ts' ? tsLoc.sourceMap.getMappedRange(vueRange.start, vueRange.end) : vueRange,
				),
				only: context.only,
			};

			if (tsLoc.type === 'embedded-ts' && !tsLoc.sourceMap.capabilities.codeActions)
				continue;

			let tsCodeActions = await tsLs.getCodeActions(tsLoc.uri, tsLoc.range, tsContext);
			if (!tsCodeActions)
				continue;

			if (tsLoc.type === 'embedded-ts' && !tsLoc.sourceMap.capabilities.organizeImports) {
				tsCodeActions = tsCodeActions.filter(codeAction =>
					codeAction.kind !== CodeActionKind.SourceOrganizeImports
					&& codeAction.kind !== CodeActionKind.SourceFixAll
				);
			}

			const data: Data = { lsType: tsLoc.lsType };
			for (const tsCodeAction of tsCodeActions) {
				if (tsCodeAction.title.indexOf('__VLS_') >= 0) continue

				const edit = tsCodeAction.edit ? tsEditToVueEdit(tsLoc.lsType, tsCodeAction.edit, sourceFiles, () => true) : undefined;
				if (tsCodeAction.edit && !edit) continue;

				result.push({
					...tsCodeAction,
					data,
					edit,
				});
			}
		}

		return result;
	}
	function onCss(uri: string, range: Range, context: CodeActionContext) {

		let result: CodeAction[] = [];

		const sourceFile = sourceFiles.get(uri);
		if (!sourceFile)
			return result;

		for (const sourceMap of sourceFile.getCssSourceMaps()) {

			if (!sourceMap.stylesheet)
				continue;

			const cssLs = getCssLs(sourceMap.mappedDocument.languageId);
			if (!cssLs)
				continue;

			for (const cssRange of sourceMap.getMappedRanges(range.start, range.end)) {
				const cssContext: CodeActionContext = {
					diagnostics: transformLocations(
						context.diagnostics,
						vueRange => sourceMap.getMappedRange(vueRange.start, vueRange.end),
					),
					only: context.only,
				};
				const cssCodeActions = cssLs.doCodeActions2(sourceMap.mappedDocument, cssRange, cssContext, sourceMap.stylesheet);
				for (const codeAction of cssCodeActions) {

					// TODO
					// cssCodeAction.edit?.changeAnnotations
					// cssCodeAction.edit?.documentChanges...

					if (codeAction.edit) {
						const vueEdit: WorkspaceEdit = {};
						for (const cssUri in codeAction.edit.changes) {
							if (cssUri === sourceMap.mappedDocument.uri) {
								if (!vueEdit.changes) {
									vueEdit.changes = {};
								}
								vueEdit.changes[uri] = transformLocations(
									vueEdit.changes[cssUri],
									cssRange_2 => sourceMap.getSourceRange(cssRange_2.start, cssRange_2.end),
								);
							}
						}
						if (codeAction.edit.documentChanges) {
							for (const cssDocChange of codeAction.edit.documentChanges) {
								if (!vueEdit.documentChanges) {
									vueEdit.documentChanges = [];
								}
								if (TextDocumentEdit.is(cssDocChange)) {
									cssDocChange.textDocument = {
										uri: uri,
										version: sourceMap.sourceDocument.version,
									};
									cssDocChange.edits = transformLocations(
										cssDocChange.edits,
										cssRange_2 => sourceMap.getSourceRange(cssRange_2.start, cssRange_2.end),
									);
									vueEdit.documentChanges.push(cssDocChange);
								}
							}
						}
						codeAction.edit = vueEdit;
					}
					if (codeAction.diagnostics) {
						codeAction.diagnostics = transformLocations(
							codeAction.diagnostics,
							cssRange_2 => sourceMap.getSourceRange(cssRange_2.start, cssRange_2.end),
						);
					}

					result.push(codeAction);
				}
			}
		}

		return result;
	}
}
