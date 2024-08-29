import type { LanguageServer } from '@volar/language-server';
import { createTypeScriptProject } from '@volar/language-server/node';
import { createParsedCommandLine, createVueLanguagePlugin, generateGlobalTypes, getAllExtensions, resolveVueCompilerOptions, VueCompilerOptions } from '@vue/language-core';
import { Disposable, getFullLanguageServicePlugins, InitializeParams } from '@vue/language-service';
import type * as ts from 'typescript';

export function initialize(
	server: LanguageServer,
	params: InitializeParams,
	ts: typeof import('typescript'),
	tsLocalized: ts.MapLike<string> | undefined
) {
	const watchingExtensions = new Set<string>();
	let fileWatcher: Promise<Disposable> | undefined;

	return server.initialize(
		params,
		createTypeScriptProject(
			ts,
			tsLocalized,
			async ({ configFileName, sys, uriConverter }) => {
				let compilerOptions: ts.CompilerOptions;
				let vueCompilerOptions: VueCompilerOptions;
				if (configFileName) {
					let commandLine = createParsedCommandLine(ts, sys, configFileName);
					let sysVersion = sys.version;
					let newSysVersion = await sys.sync();
					while (sysVersion !== newSysVersion) {
						commandLine = createParsedCommandLine(ts, sys, configFileName);
						sysVersion = newSysVersion;
						newSysVersion = await sys.sync();
					}
					compilerOptions = commandLine.options;
					vueCompilerOptions = commandLine.vueOptions;
				}
				else {
					compilerOptions = ts.getDefaultCompilerOptions();
					vueCompilerOptions = resolveVueCompilerOptions({});
				}
				vueCompilerOptions.__test = params.initializationOptions.typescript.disableAutoImportCache;
				updateFileWatcher(vueCompilerOptions);
				return {
					languagePlugins: [
						createVueLanguagePlugin(
							ts,
							compilerOptions,
							vueCompilerOptions,
							s => uriConverter.asFileName(s)
						),
					],
					setup({ project }) {
						project.vue = { compilerOptions: vueCompilerOptions };

						if (project.typescript) {
							const globalTypesName = `__global_types_${vueCompilerOptions.target}_${vueCompilerOptions.strictTemplates}.d.ts`;
							const fileExists = project.typescript.languageServiceHost.fileExists.bind(project.typescript.languageServiceHost);
							const getScriptSnapshot = project.typescript.languageServiceHost.getScriptSnapshot.bind(project.typescript.languageServiceHost);
							const snapshots = new Map<string, ts.IScriptSnapshot>();
							project.typescript.languageServiceHost.fileExists = path => {
								if (path.endsWith(globalTypesName)) {
									return true;
								}
								return fileExists(path);
							};
							project.typescript.languageServiceHost.getScriptSnapshot = path => {
								if (path.endsWith(globalTypesName)) {
									if (!snapshots.has(path)) {
										const contents = generateGlobalTypes(vueCompilerOptions.lib, vueCompilerOptions.target, vueCompilerOptions.strictTemplates);
										snapshots.set(path, {
											getText: (start, end) => contents.substring(start, end),
											getLength: () => contents.length,
											getChangeRange: () => undefined,
										});
									}
									return snapshots.get(path)!;
								}
								return getScriptSnapshot(path);
							};
						}
					},
				};
			}
		),
		getFullLanguageServicePlugins(ts, { disableAutoImportCache: params.initializationOptions.typescript.disableAutoImportCache })
	);

	function updateFileWatcher(vueCompilerOptions: VueCompilerOptions) {
		const extensions = [
			'js', 'cjs', 'mjs', 'ts', 'cts', 'mts', 'jsx', 'tsx', 'json',
			...getAllExtensions(vueCompilerOptions).map(ext => ext.slice(1)),
		];
		const newExtensions = extensions.filter(ext => !watchingExtensions.has(ext));
		if (newExtensions.length) {
			for (const ext of newExtensions) {
				watchingExtensions.add(ext);
			}
			fileWatcher?.then(dispose => dispose.dispose());
			fileWatcher = server.fileWatcher.watchFiles(['**/*.{' + [...watchingExtensions].join(',') + '}']);
		}
	}
}
