import type { HtmlLanguageServiceContext } from '../types';
import type * as vscode from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';

export function register({ getHtmlDocument, htmlLs }: HtmlLanguageServiceContext) {
	return (document: TextDocument, position: vscode.Position): vscode.LinkedEditingRanges | null => {
		const ranges = htmlLs.findLinkedEditingRanges(document, position, getHtmlDocument(document));
		if (ranges) {
			return { ranges };
		}
		return null;
	}
}
