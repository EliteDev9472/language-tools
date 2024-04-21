import { VirtualCode, buildMappings, resolveCommonLanguageId, toString } from '@volar/language-core';
import { computed } from 'computeds';
import type * as ts from 'typescript';
import type { Code, Sfc, SfcBlock, VueLanguagePlugin } from '../types';
import { VueEmbeddedCode } from './embeddedFile';

export function computedFiles(
	plugins: ReturnType<VueLanguagePlugin>[],
	fileName: string,
	sfc: Sfc,
) {

	const nameToBlock = computed(() => {
		const blocks: Record<string, SfcBlock> = {};
		if (sfc.template) {
			blocks[sfc.template.name] = sfc.template;
		}
		if (sfc.script) {
			blocks[sfc.script.name] = sfc.script;
		}
		if (sfc.scriptSetup) {
			blocks[sfc.scriptSetup.name] = sfc.scriptSetup;
		}
		for (const block of sfc.styles) {
			blocks[block.name] = block;
		}
		for (const block of sfc.customBlocks) {
			blocks[block.name] = block;
		}
		return blocks;
	});
	const pluginsResult = plugins.map(plugin => computedPluginFiles(plugins, plugin, fileName, sfc, nameToBlock));
	const flatResult = computed(() => pluginsResult.map(r => r()).flat());
	const structuredResult = computed(() => {

		const embeddedCodes: VirtualCode[] = [];

		let remain = [...flatResult()];

		while (remain.length) {
			const beforeLength = remain.length;
			consumeRemain();
			if (beforeLength === remain.length) {
				break;
			}
		}

		for (const { file } of remain) {
			console.error('Unable to resolve embedded: ' + file.parentCodeId + ' -> ' + file.id);
		}

		return embeddedCodes;

		function consumeRemain() {
			for (let i = remain.length - 1; i >= 0; i--) {
				const { file, snapshot, mappings } = remain[i];
				if (!file.parentCodeId) {
					embeddedCodes.push({
						id: file.id,
						languageId: resolveCommonLanguageId(`/dummy.${file.lang}`),
						linkedCodeMappings: file.linkedCodeMappings,
						snapshot,
						mappings,
						embeddedCodes: [],
					});
					remain.splice(i, 1);
				}
				else {
					const parent = findParentStructure(file.parentCodeId, embeddedCodes);
					if (parent) {
						parent.embeddedCodes ??= [];
						parent.embeddedCodes.push({
							id: file.id,
							languageId: resolveCommonLanguageId(`/dummy.${file.lang}`),
							linkedCodeMappings: file.linkedCodeMappings,
							snapshot,
							mappings,
							embeddedCodes: [],
						});
						remain.splice(i, 1);
					}
				}
			}
		}
		function findParentStructure(id: string, current: VirtualCode[]): VirtualCode | undefined {
			for (const child of current) {
				if (child.id === id) {
					return child;
				}
				let parent = findParentStructure(id, child.embeddedCodes ?? []);
				if (parent) {
					return parent;
				}
			}
		}
	});

	return structuredResult;
}

function computedPluginFiles(
	plugins: ReturnType<VueLanguagePlugin>[],
	plugin: ReturnType<VueLanguagePlugin>,
	fileName: string,
	sfc: Sfc,
	nameToBlock: () => Record<string, SfcBlock>,
) {
	const embeddedFiles: Record<string, () => { file: VueEmbeddedCode; snapshot: ts.IScriptSnapshot; }> = {};
	const files = computed(() => {
		try {
			if (!plugin.getEmbeddedCodes) {
				return Object.values(embeddedFiles);
			}
			const fileInfos = plugin.getEmbeddedCodes(fileName, sfc);
			for (const oldId of Object.keys(embeddedFiles)) {
				if (!fileInfos.some(file => file.id === oldId)) {
					delete embeddedFiles[oldId];
				}
			}
			for (const fileInfo of fileInfos) {
				if (!embeddedFiles[fileInfo.id]) {
					embeddedFiles[fileInfo.id] = computed(() => {
						const content: Code[] = [];
						const file = new VueEmbeddedCode(fileInfo.id, fileInfo.lang, content);
						for (const plugin of plugins) {
							if (!plugin.resolveEmbeddedCode) {
								continue;
							}
							try {
								plugin.resolveEmbeddedCode(fileName, sfc, file);
							}
							catch (e) {
								console.error(e);
							}
						}
						const newText = toString(file.content);
						const changeRanges = new Map<ts.IScriptSnapshot, ts.TextChangeRange | undefined>();
						const snapshot: ts.IScriptSnapshot = {
							getText: (start, end) => newText.slice(start, end),
							getLength: () => newText.length,
							getChangeRange(oldSnapshot) {
								if (!changeRanges.has(oldSnapshot)) {
									changeRanges.set(oldSnapshot, undefined);
									const oldText = oldSnapshot.getText(0, oldSnapshot.getLength());
									const changeRange = fullDiffTextChangeRange(oldText, newText);
									if (changeRange) {
										changeRanges.set(oldSnapshot, changeRange);
									}
								}
								return changeRanges.get(oldSnapshot);
							},
						};
						return {
							file,
							snapshot,
						};
					});
				}
			}
		}
		catch (e) {
			console.error(e);
		}
		return Object.values(embeddedFiles);
	});

	return computed(() => {
		return files().map(_file => {

			const { file, snapshot } = _file();
			const mappings = buildMappings(file.content);
			const newMappings: typeof mappings = [];
			let lastValidMapping: typeof mappings[number] | undefined;

			for (let i = 0; i < mappings.length; i++) {
				const mapping = mappings[i];
				if (mapping.source !== undefined) {
					const block = nameToBlock()[mapping.source];
					if (block) {
						mapping.sourceOffsets = mapping.sourceOffsets.map(offset => offset + block.startTagEnd);
					}
					else {
						// ignore
					}
					mapping.source = undefined;
				}
				if (mapping.data.__combineOffsetMapping !== undefined) {
					const offsetMapping = mappings[i - mapping.data.__combineOffsetMapping];
					if (typeof offsetMapping === 'string' || !offsetMapping) {
						throw new Error('Invalid offset mapping, mappings: ' + mappings.length + ', i: ' + i + ', offset: ' + mapping.data.__combineOffsetMapping);
					}
					offsetMapping.sourceOffsets.push(...mapping.sourceOffsets);
					offsetMapping.generatedOffsets.push(...mapping.generatedOffsets);
					offsetMapping.lengths.push(...mapping.lengths);
					continue;
				}
				else if (mapping.data.__combineLastMapping) {
					lastValidMapping!.sourceOffsets.push(...mapping.sourceOffsets);
					lastValidMapping!.generatedOffsets.push(...mapping.generatedOffsets);
					lastValidMapping!.lengths.push(...mapping.lengths);
					continue;
				}
				else {
					lastValidMapping = mapping;
				}
				newMappings.push(mapping);
			}

			return {
				file,
				snapshot,
				mappings: newMappings,
			};
		});
	});
}

function fullDiffTextChangeRange(oldText: string, newText: string): ts.TextChangeRange | undefined {
	for (let start = 0; start < oldText.length && start < newText.length; start++) {
		if (oldText[start] !== newText[start]) {
			let end = oldText.length;
			for (let i = 0; i < oldText.length - start && i < newText.length - start; i++) {
				if (oldText[oldText.length - i - 1] !== newText[newText.length - i - 1]) {
					break;
				}
				end--;
			}
			let length = end - start;
			let newLength = length + (newText.length - oldText.length);
			if (newLength < 0) {
				length -= newLength;
				newLength = 0;
			}
			return {
				span: { start, length },
				newLength,
			};
		}
	}
}
