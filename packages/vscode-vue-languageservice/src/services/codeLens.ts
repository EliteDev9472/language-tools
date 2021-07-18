import type * as vscode from 'vscode-languageserver';
import { Commands } from '../commands';
import type { SourceFile } from '../sourceFile';
import type { ApiLanguageServiceContext } from '../types';

export const options = {
	references: true,
	pugTool: true,
	scriptSetupTool: true,
};

export interface TsCodeLensData {
	lsType: 'template' | 'script',
	uri: string,
	offset: number,
	tsUri: string,
	tsOffset: number,
}

export function register({ sourceFiles }: ApiLanguageServiceContext) {
	return (uri: string) => {

		const sourceFile = sourceFiles.get(uri);
		if (!sourceFile) return;

		const document = sourceFile.getTextDocument();
		let result: vscode.CodeLens[] = [];

		if (options.references) {
			result = result.concat(getTsResult(sourceFile));
		}
		if (options.pugTool) {
			result = result.concat(getHtmlResult(sourceFile));
			result = result.concat(getPugResult(sourceFile));
		}
		if (options.scriptSetupTool) {
			result = result.concat(getScriptSetupResult(sourceFile));
		}

		return result;

		function getTsResult(sourceFile: SourceFile) {
			const result: vscode.CodeLens[] = [];
			for (const sourceMap of sourceFile.getTsSourceMaps()) {
				for (const maped of sourceMap) {
					if (!maped.data.capabilities.referencesCodeLens) continue;
					const data: TsCodeLensData = {
						lsType: sourceMap.lsType,
						uri: uri,
						offset: maped.sourceRange.start,
						tsUri: sourceMap.mappedDocument.uri,
						tsOffset: maped.mappedRange.start,
					};
					result.push({
						range: {
							start: document.positionAt(maped.sourceRange.start),
							end: document.positionAt(maped.sourceRange.end),
						},
						data,
					});
				}
			}
			return result;
		}
		function getScriptSetupResult(sourceFile: SourceFile) {
			const result: vscode.CodeLens[] = [];
			const descriptor = sourceFile.getDescriptor();
			const data = sourceFile.getScriptSetupData();
			if (descriptor.scriptSetup && data) {
				result.push({
					range: {
						start: document.positionAt(descriptor.scriptSetup.loc.start),
						end: document.positionAt(descriptor.scriptSetup.loc.end),
					},
					command: {
						title: 'ref sugar ' + (data.labels.length ? '☑' : '☐'),
						command: data.labels.length ? Commands.UNUSE_REF_SUGAR : Commands.USE_REF_SUGAR,
						arguments: [uri],
					},
				});
			}
			return result;
		}
		function getHtmlResult(sourceFile: SourceFile) {
			const sourceMaps = sourceFile.getHtmlSourceMaps();
			for (const sourceMap of sourceMaps) {
				for (const maped of sourceMap) {
					return getPugHtmlConvertCodeLens(
						'html',
						{
							start: sourceMap.sourceDocument.positionAt(maped.sourceRange.start),
							end: sourceMap.sourceDocument.positionAt(maped.sourceRange.start),
						},
					);
				}
			}
			return [];
		}
		function getPugResult(sourceFile: SourceFile) {
			const sourceMaps = sourceFile.getPugSourceMaps();
			for (const sourceMap of sourceMaps) {
				for (const maped of sourceMap) {
					return getPugHtmlConvertCodeLens(
						'pug',
						{
							start: sourceMap.sourceDocument.positionAt(maped.sourceRange.start),
							end: sourceMap.sourceDocument.positionAt(maped.sourceRange.start),
						},
					);
				}
			}
			return [];
		}
		function getPugHtmlConvertCodeLens(current: 'html' | 'pug', range: vscode.Range) {
			const result: vscode.CodeLens[] = [];
			result.push({
				range,
				command: {
					title: 'pug ' + (current === 'pug' ? '☑' : '☐'),
					command: current === 'pug' ? Commands.PUG_TO_HTML : Commands.HTML_TO_PUG,
					arguments: [uri],
				},
			});
			return result;
		}
	}
}
