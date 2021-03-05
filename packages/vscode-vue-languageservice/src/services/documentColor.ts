import type { TsApiRegisterOptions } from '../types';
import {
	ColorInformation,
} from 'vscode-languageserver/node';
import { SourceFile } from '../sourceFile';
import * as languageServices from '../utils/languageServices';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export function register({ sourceFiles }: TsApiRegisterOptions) {
	return (document: TextDocument) => {
		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) return;

		const cssResult = getCssResult(sourceFile);
		return cssResult;

		function getCssResult(sourceFile: SourceFile) {
			const result: ColorInformation[] = [];
			const sourceMaps = sourceFile.getCssSourceMaps();
			for (const sourceMap of sourceMaps) {
				const cssLanguageService = languageServices.getCssLanguageService(sourceMap.mappedDocument.languageId);
				if (!cssLanguageService || !sourceMap.stylesheet) continue;
				let colors = cssLanguageService.findDocumentColors(sourceMap.mappedDocument, sourceMap.stylesheet);
				for (const color of colors) {
					const vueRange = sourceMap.getSourceRange(color.range.start, color.range.end);
					if (vueRange) {
						result.push({
							...color,
							range: vueRange,
						});
					}
				}
			}
			return result;
		}
	}
}
