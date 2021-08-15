import type * as ts from 'typescript/lib/tsserverlibrary';
import { getStartEnd, parseBindingRanges } from './scriptSetupRanges';
import type { TextRange } from './types';

export type ScriptSetupRanges = ReturnType<typeof parseUnuseScriptSetupRanges>;

type PropTypeArg = {
	name: TextRange,
	type: TextRange,
	required: boolean,
	default: TextRange | undefined,
};

type EmitTypeArg = {
	name: TextRange,
	restArgs: TextRange | undefined,
};

export function parseUnuseScriptSetupRanges(ts: typeof import('typescript/lib/tsserverlibrary'), ast: ts.SourceFile) {

	const imports: TextRange[] = [];
	const bindings = parseBindingRanges(ts, ast);

	let defineProps: {
		range: TextRange,
		binding: TextRange | undefined,
		typeArgs: PropTypeArg[],
	} | {
		range: TextRange,
		binding: TextRange | undefined,
		args: TextRange,
	} | undefined;

	let defineEmits: {
		range: TextRange,
		binding: TextRange | undefined,
		typeArgs: EmitTypeArg[],
	} | {
		range: TextRange,
		binding: TextRange | undefined,
		args: TextRange,
	} | undefined;

	let useSlots: {
		range: TextRange,
		binding: TextRange | undefined,
	} | undefined;

	let useAttrs: {
		range: TextRange,
		binding: TextRange | undefined,
	} | undefined;

	const definePropsTypeArgsMap = new Map<string, PropTypeArg>();

	ast.forEachChild(node => {
		visitNode(node, ast, undefined);
	});

	if (defineProps && 'typeArgs' in defineProps && defineProps.typeArgs.length) {
		ast.forEachChild(node => {
			visitNode_withDefaults(node);
		});
	}

	return {
		imports,
		defineProps,
		defineEmits,
		useSlots,
		useAttrs,
		bindings,
	};

	function _getStartEnd(node: ts.Node) {
		return getStartEnd(node, ast);
	}
	function visitNode(node: ts.Node, parent: ts.Node, parentParent: ts.Node | undefined) {
		if (ts.isImportDeclaration(node)) {
			imports.push(_getStartEnd(node));
		}
		else if (
			ts.isCallExpression(node)
			&& ts.isIdentifier(node.expression)
		) {

			const callText = node.expression.getText(ast);
			const declaration = ts.isVariableDeclaration(parent) ? parent : undefined;
			const fullNode = declaration ? (parentParent ?? node) : node;
			const binding = declaration ? _getStartEnd(declaration.name) : undefined;
			const typeArg = node.typeArguments?.length && ts.isTypeLiteralNode(node.typeArguments[0]) ? node.typeArguments[0] : undefined;

			if (callText === 'defineProps' && node.arguments.length) {
				defineProps = {
					range: _getStartEnd(fullNode),
					binding,
					args: _getStartEnd(node.arguments[0]),
				};
			}
			if (callText === 'defineEmits' && node.arguments.length) {
				defineEmits = {
					range: _getStartEnd(fullNode),
					binding,
					args: _getStartEnd(node.arguments[0]),
				};
			}
			if (callText === 'useSlots') {
				useSlots = {
					range: _getStartEnd(fullNode),
					binding,
				};
			}
			if (callText === 'useAttrs') {
				useAttrs = {
					range: _getStartEnd(fullNode),
					binding,
				};
			}
			if (callText === 'defineProps' && typeArg) {
				defineProps = {
					range: _getStartEnd(fullNode),
					binding,
					typeArgs: [],
				};

				for (const member of typeArg.members) {
					if (ts.isPropertySignature(member) && member.type) {

						const propName = _getStartEnd(member.name);
						const propType = _getStartEnd(member.type);

						defineProps.typeArgs.push({
							name: propName,
							type: propType,
							required: !member.questionToken,
							default: undefined,
						});
						definePropsTypeArgsMap.set(member.name.getText(ast), defineProps.typeArgs[defineProps.typeArgs.length - 1]);
					}
				}
			}
			if (callText === 'defineEmits' && typeArg) {
				defineEmits = {
					range: _getStartEnd(fullNode),
					binding,
					typeArgs: [],
				};

				for (const member of typeArg.members) {
					if (ts.isCallSignatureDeclaration(member) && member.parameters.length) {

						const emitName = member.parameters[0].type;

						if (emitName) {

							let restArgs: TextRange | undefined;

							if (member.parameters.length >= 2) {
								const firstParam = member.parameters[1];
								const lastParam = member.parameters[member.parameters.length - 1];
								restArgs = {
									start: firstParam.getStart(ast),
									end: lastParam.getEnd(),
								};
							}

							defineEmits.typeArgs.push({
								name: _getStartEnd(emitName),
								restArgs,
							});
						}
					}
				}
			}
		}
		node.forEachChild(child => visitNode(child, node, parent));
	}
	function visitNode_withDefaults(node: ts.Node) {
		if (
			ts.isCallExpression(node)
			&& ts.isIdentifier(node.expression)
			&& node.expression.getText(ast) === 'withDefaults'
		) {
			if (node.arguments.length >= 2) {

				const defaults = node.arguments[1];

				if (ts.isObjectLiteralExpression(defaults)) {
					for (const defaultProp of defaults.properties) {
						if (defaultProp.name) {

							const initializer = ts.isPropertyAssignment(defaultProp) ? defaultProp.initializer : defaultProp.name;
							const defaultPropName = defaultProp.name.getText(ast);
							const typeProp = definePropsTypeArgsMap.get(defaultPropName);

							if (typeProp) {
								typeProp.default = _getStartEnd(initializer);
							}
						}
					}
				}
			}
		}
		node.forEachChild(child => visitNode_withDefaults(child));
	}
}
