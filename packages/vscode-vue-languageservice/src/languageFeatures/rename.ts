import {
	Position,
	TextDocument,
	WorkspaceEdit,
	Location,
	TextEdit,
} from 'vscode-languageserver';
import { SourceFile } from '../sourceFiles';
import {
	getTsActionEntries,
	getSourceTsLocations,
	findSourceFileByTsUri,
} from '../utils/commons';
import { hyphenate } from '@vue/shared';
import { NodeTypes } from '@vue/compiler-dom';

export function register(sourceFiles: Map<string, SourceFile>) {
	return (document: TextDocument, position: Position, newName: string) => {
		const sourceFile = sourceFiles.get(document.uri);
		if (!sourceFile) return;
		const range = { start: position, end: position };

		const tsResult = getTsResult(sourceFile);
		const htmlResult = getHtmlResult(sourceFile);
		const cssResult = getCssResult(sourceFile);

		let result: WorkspaceEdit | undefined;
		for (const _result of [tsResult, ...cssResult, ...htmlResult]) {
			if (_result.changes && Object.keys(_result.changes).length) {
				result = _result;
			}
		}
		return result;

		function getTsResult(sourceFile: SourceFile) {
			let tsEdits: WorkspaceEdit[] = [];

			for (const sourceMap of sourceFile.getTsSourceMaps()) {
				for (const tsLoc of sourceMap.findVirtualLocations(range)) {
					if (!tsLoc.maped.data.capabilities.references) continue;
					const entries = getTsActionEntries(sourceMap.virtualDocument, tsLoc.range, tsLoc.maped.data.vueTag, 'rename', getRenameLocations, sourceMap.languageService, sourceFiles);

					for (const entry of entries) {
						const entryDocument = sourceMap.languageService.getTextDocument(entry.uri);
						if (!entryDocument) continue;
						const tsEdit = sourceMap.languageService.doRename(entryDocument, entry.range.start, newName);
						if (!tsEdit) continue;
						tsEdits.push(tsEdit);
					}

					function getRenameLocations(document: TextDocument, position: Position) {
						const workspaceEdit = sourceMap.languageService.doRename(document, position, newName);
						if (!workspaceEdit) return [];

						const locations: Location[] = [];
						for (const uri in workspaceEdit.changes) {
							const edits = workspaceEdit.changes[uri];
							for (const edit of edits) {
								const location = Location.create(uri, edit.range);
								locations.push(location);
							}
						}

						return locations;
					}
				}
			}

			for (const tsEdit of tsEdits) {
				keepHtmlTagStyle(tsEdit);
			}
			const vueEdits = tsEdits.map(edit => getSourceWorkspaceEdit(edit));
			const vueEdit = margeWorkspaceEdits(vueEdits);
			return deduplication(vueEdit);

			function keepHtmlTagStyle(tsWorkspaceEdit: WorkspaceEdit) {
				if (!tsWorkspaceEdit?.changes) return;
				for (const uri in tsWorkspaceEdit.changes) {
					const editSourceFile = findSourceFileByTsUri(sourceFiles, uri);
					if (!editSourceFile) continue;
					for (const sourceMap of editSourceFile.getTsSourceMaps()) {
						if (sourceMap.virtualDocument.uri !== uri) continue;
						for (const textEdit of tsWorkspaceEdit.changes[uri]) {
							const isHtmlTag = sourceMap.findFirstVueLocation(textEdit.range)?.maped.data.templateNodeType === NodeTypes.ELEMENT;
							const oldName = sourceMap.virtualDocument.getText(textEdit.range);
							if (isHtmlTag && isHyphenateName(oldName)) {
								textEdit.newText = hyphenate(textEdit.newText);
							}
						}
					}
				}
				function isHyphenateName(name: string) {
					return name === hyphenate(name);
				}
			}
		}
		function getHtmlResult(sourceFile: SourceFile) {
			const result: WorkspaceEdit[] = [];
			for (const sourceMap of sourceFile.getHtmlSourceMaps()) {
				for (const htmlLoc of sourceMap.findVirtualLocations(range)) {
					const workspaceEdit = sourceMap.languageService.doRename(sourceMap.virtualDocument, htmlLoc.range.start, newName, sourceMap.htmlDocument);
					if (workspaceEdit) {
						if (workspaceEdit.changes) {
							for (const uri in workspaceEdit.changes) {
								const edits = workspaceEdit.changes[uri];
								for (const edit of edits) {
									const vueLoc = sourceMap.findFirstVueLocation(edit.range);
									if (vueLoc) edit.range = vueLoc.range;
								}
							}
						}
						result.push(workspaceEdit);
					}
				}
			}
			return result;
		}
		function getCssResult(sourceFile: SourceFile) {
			const result: WorkspaceEdit[] = [];
			for (const sourceMap of sourceFile.getCssSourceMaps()) {
				for (const cssLoc of sourceMap.findVirtualLocations(range)) {
					const workspaceEdit = sourceMap.languageService.doRename(sourceMap.virtualDocument, cssLoc.range.start, newName, sourceMap.stylesheet);
					if (workspaceEdit) {
						if (workspaceEdit.changes) {
							for (const uri in workspaceEdit.changes) {
								const edits = workspaceEdit.changes[uri];
								for (const edit of edits) {
									const vueLoc = sourceMap.findFirstVueLocation(edit.range);
									if (vueLoc) edit.range = vueLoc.range;
								}
							}
						}
						result.push(workspaceEdit);
					}
				}
			}
			return result;
		}
		function getSourceWorkspaceEdit(workspaceEdit: WorkspaceEdit) {
			const newWorkspaceEdit: WorkspaceEdit = {
				changes: {}
			};
			for (const uri in workspaceEdit.changes) {
				const edits = workspaceEdit.changes[uri];
				for (const edit of edits) {
					const location = Location.create(uri, edit.range);
					const sourceLocations = getSourceTsLocations(location, sourceFiles);
					for (const sourceLocation of sourceLocations) {
						const sourceTextEdit = TextEdit.replace(sourceLocation.range, edit.newText);
						const sourceUri = sourceLocation.uri;
						if (!newWorkspaceEdit.changes![sourceUri]) {
							newWorkspaceEdit.changes![sourceUri] = [];
						}
						newWorkspaceEdit.changes![sourceUri].push(sourceTextEdit);
					}
				}
			}
			return newWorkspaceEdit;
		}
		function deduplication(workspaceEdit: WorkspaceEdit) {
			for (const uri in workspaceEdit.changes) {
				let edits = workspaceEdit.changes[uri];
				const map = new Map<string, TextEdit>();
				for (const edit of edits) {
					map.set(`${edit.newText}:${JSON.stringify(edit.range)}`, edit);
				}
				edits = [...map.values()];
				workspaceEdit.changes[uri] = edits;
			}
			return workspaceEdit;
		}
		function margeWorkspaceEdits(workspaceEdits: WorkspaceEdit[]) {
			const newWorkspaceEdit: WorkspaceEdit = {
				changes: {}
			};
			for (const workspaceEdit of workspaceEdits) {
				for (const uri in workspaceEdit.changes) {
					if (!newWorkspaceEdit.changes![uri]) {
						newWorkspaceEdit.changes![uri] = [];
					}
					const edits = workspaceEdit.changes[uri];
					newWorkspaceEdit.changes![uri] = newWorkspaceEdit.changes![uri].concat(edits);
				}
			}
			return newWorkspaceEdit;
		}
	}
}
