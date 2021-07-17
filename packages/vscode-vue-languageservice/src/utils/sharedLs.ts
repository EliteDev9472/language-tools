import * as shared from '@volar/shared';
import type * as ts from 'typescript';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import * as ts2 from 'vscode-typescript-languageservice';

// Fast dummy TS language service, only has one script.
let dummyTsScriptVersion = 0;
let dummyTsScriptKind = 3;
let dummyTsScript: ts.IScriptSnapshot | undefined;
let dummyTsLs: ts2.LanguageService | undefined;
export function getDummyTsLs(
	ts: typeof import('typescript/lib/tsserverlibrary'),
	doc: TextDocument,
	getPreferences: ts2.LanguageServiceHost['getPreferences'],
	getFormatOptions: ts2.LanguageServiceHost['getFormatOptions'],
) {
	if (!dummyTsLs) {
		dummyTsLs = ts2.createLanguageService(
			ts,
			{
				getPreferences,
				getFormatOptions,
				getCompilationSettings: () => ({}),
				getScriptFileNames: () => [shared.normalizeFileName(`dummy.${dummyTsScriptVersion}.ts`)],
				getScriptVersion: () => dummyTsScriptVersion.toString(),
				getScriptSnapshot: () => dummyTsScript,
				getScriptKind: () => dummyTsScriptKind,
				getCurrentDirectory: () => '',
				getDefaultLibFileName: () => '',
			},
		);
	}
	dummyTsScriptVersion++;
	switch (doc.languageId) {
		case 'javascript': dummyTsScriptKind = ts.ScriptKind.JS; break;
		case 'typescript': dummyTsScriptKind = ts.ScriptKind.TS; break;
		case 'javascriptreact': dummyTsScriptKind = ts.ScriptKind.JSX; break;
		case 'typescriptreact': dummyTsScriptKind = ts.ScriptKind.TSX; break;
		default: dummyTsScriptKind = ts.ScriptKind.TS; break;
	}
	dummyTsScript = ts.ScriptSnapshot.fromString(doc.getText());
	return {
		ls: dummyTsLs,
		uri: shared.fsPathToUri(`dummy.${dummyTsScriptVersion}.ts`),
	};
}
