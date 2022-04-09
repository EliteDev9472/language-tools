import { computed, Ref, ComputedRef } from '@vue/reactivity';
import { EmbeddedFileSourceMap, Teleport } from '../utils/sourceMaps';
import * as SourceMaps from '@volar/source-map';
import { generate as genScript } from '@volar/vue-code-gen/out/generators/script';
import * as templateGen from '@volar/vue-code-gen/out/generators/template_scriptSetup';
import type { parseScriptRanges } from '@volar/vue-code-gen/out/parsers/scriptRanges';
import type { parseScriptSetupRanges } from '@volar/vue-code-gen/out/parsers/scriptSetupRanges';
import { getVueLibraryName } from '../utils/localTypes';
import type { EmbeddedFileMappingData, TextRange } from '@volar/vue-code-gen';
import { Embedded, EmbeddedFile, Sfc } from '../vueFile';

export function useSfcScriptGen<T extends 'template' | 'script'>(
	lsType: T,
	fileName: string,
	vueFileContent: Ref<string>,
	script: Ref<Sfc['script']>,
	scriptSetup: Ref<Sfc['scriptSetup']>,
	scriptRanges: Ref<ReturnType<typeof parseScriptRanges> | undefined>,
	scriptSetupRanges: Ref<ReturnType<typeof parseScriptSetupRanges> | undefined>,
	sfcTemplateCompileResult: Ref<ReturnType<(typeof import('@volar/vue-code-gen'))['compileSFCTemplate']> | undefined>,
	sfcStyles: ReturnType<(typeof import('./useSfcStyles'))['useSfcStyles']>['files'],
	isVue2: boolean,
	getCssVBindRanges: (cssEmbeddeFile: EmbeddedFile) => TextRange[],
) {

	const htmlGen = computed(() => {
		if (sfcTemplateCompileResult.value?.ast) {
			return templateGen.generate(sfcTemplateCompileResult.value.ast);
		}
	});
	const codeGen = computed(() =>
		genScript(
			lsType,
			fileName,
			script.value ?? undefined,
			scriptSetup.value ?? undefined,
			scriptRanges.value,
			scriptSetupRanges.value,
			() => htmlGen.value,
			() => {
				const bindTexts: string[] = [];
				for (const style of sfcStyles.value) {
					const binds = getCssVBindRanges(style);
					for (const cssBind of binds) {
						const bindText = style.content.substring(cssBind.start, cssBind.end);
						bindTexts.push(bindText);
					}
				}
				return bindTexts;
			},
			getVueLibraryName(isVue2),
		)
	);
	const lang = computed(() => {
		return !script.value && !scriptSetup.value ? 'ts'
			: scriptSetup.value && scriptSetup.value.lang !== 'js' ? scriptSetup.value.lang
				: script.value && script.value.lang !== 'js' ? script.value.lang
					: 'js'
	});
	const file = computed(() => {

		if (lsType === 'script') {

			const file: EmbeddedFile = {
				fileName: fileName + '.' + lang.value,
				lang: lang.value,
				content: codeGen.value.codeGen.getText(),
				capabilities: {
					diagnostics: !script.value?.src,
					foldingRanges: false,
					formatting: false,
					documentSymbol: false,
					codeActions: !script.value?.src,
				},
				data: undefined,
			};

			return file;
		}
		else if (script.value || scriptSetup.value) {

			const file: EmbeddedFile = {
				fileName: fileName + '.__VLS_script.' + lang.value,
				lang: lang.value,
				content: codeGen.value.codeGen.getText(),
				capabilities: {
					diagnostics: false,
					foldingRanges: false,
					formatting: false,
					documentSymbol: false,
					codeActions: false,
				},
				data: undefined,
			};

			return file;
		}
	});
	const embedded = computed<Embedded | undefined>(() => {
		if (file.value) {
			return {
				sourceMap: new EmbeddedFileSourceMap(codeGen.value.codeGen.getMappings(parseMappingSourceRange)),
				file: file.value,
			};
		}
	});
	const teleport = computed(() => {

		const teleport = new Teleport();

		for (const mapping of codeGen.value.teleports) {
			teleport.mappings.push(mapping);
		}

		return teleport;
	});

	return {
		lang,
		file: file as T extends 'script' ? ComputedRef<EmbeddedFile<undefined>> : ComputedRef<EmbeddedFile<undefined> | undefined>,
		embedded,
		teleport,
	};

	// TODO
	function parseMappingSourceRange(data: EmbeddedFileMappingData, sourceRange: SourceMaps.Range) {
		if (data.vueTag === 'scriptSrc' && script.value?.src) {
			const vueStart = vueFileContent.value.substring(0, script.value.startTagEnd).lastIndexOf(script.value.src);
			const vueEnd = vueStart + script.value.src.length;
			return {
				start: vueStart - 1,
				end: vueEnd + 1,
			};
		}
		else if (data.vueTag === 'script' && script.value) {
			return {
				start: script.value.startTagEnd + sourceRange.start,
				end: script.value.startTagEnd + sourceRange.end,
			};
		}
		else if (data.vueTag === 'scriptSetup' && scriptSetup.value) {
			return {
				start: scriptSetup.value.startTagEnd + sourceRange.start,
				end: scriptSetup.value.startTagEnd + sourceRange.end,
			};
		}
		else {
			return sourceRange;
		}
	}
}
