import { VueLanguagePlugin } from '../types';

const presetInitialIndentBrackets: Record<string, [string, string] | undefined> = {
	html: ['<template>', '</template>'],
};

const plugin: VueLanguagePlugin = () => {

	return {

		getEmbeddedFileNames(fileName, sfc) {
			if (sfc.template) {
				return [fileName + '.template.' + sfc.template.lang];
			}
			return [];
		},

		resolveEmbeddedFile(fileName, sfc, embeddedFile) {
			const match = embeddedFile.fileName.match(/^(.*)\.template\.([^.]+)$/);
			if (match && sfc.template) {
				embeddedFile.capabilities = {
					diagnostics: true,
					foldingRanges: true,
					formatting: {
						initialIndentBracket: presetInitialIndentBrackets[sfc.template.lang],
					},
					documentSymbol: true,
					codeActions: true,
					inlayHints: true,
				};
				embeddedFile.isTsHostFile = false;
				embeddedFile.appendContentFromSFCBlock(
					sfc.template,
					0,
					sfc.template.content.length,
					{
						hover: true,
						references: true,
						definitions: true,
						diagnostic: true,
						rename: true,
						completion: true,
						semanticTokens: true,
					},
				);
			}
		},
	};
};
export = plugin;
