/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { LanguageServiceDefaultsImpl } from './monaco.contribution';
import * as ts from '../lib/typescriptServices';
import { TypeScriptWorker } from './worker';

import Uri = monaco.Uri;
import Position = monaco.Position;
import Range = monaco.Range;
import Thenable = monaco.Thenable;
import Promise = monaco.Promise;
import CancellationToken = monaco.CancellationToken;
import IDisposable = monaco.IDisposable;

let snippets = {
	"For Loop": {
		"prefix": "for",
		"body": [
			"for (let ${1:index} = 0; ${1:index} < 4; ${1:index}++) {",
			"\t$0",
			"}"
		],
		"description": "For Loop"
	},
	"If Statement": {
		"prefix": "if",
		"body": [
			"if (${1:condition}) {",
			"\t$0",
			"}"
		],
		"description": "If Statement"
	},
	"While Statement": {
		"prefix": "while",
		"body": [
			"while (${1:condition}) {",
			"\t$0",
			"}"
		],
		"description": "While Statement"
	}
}

export abstract class Adapter {

	constructor(protected _worker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>) {
	}

	protected _positionToOffset(uri: Uri, position: monaco.IPosition): number {
		let model = monaco.editor.getModel(uri);
		return model.getOffsetAt(position);
	}

	protected _offsetToPosition(uri: Uri, offset: number): monaco.IPosition {
		let model = monaco.editor.getModel(uri);
		return model.getPositionAt(offset);
	}

	protected _textSpanToRange(uri: Uri, span: ts.TextSpan): monaco.IRange {
		let p1 = this._offsetToPosition(uri, span.start);
		let p2 = this._offsetToPosition(uri, span.start + span.length);
		let {lineNumber: startLineNumber, column: startColumn} = p1;
		let {lineNumber: endLineNumber, column: endColumn} = p2;
		return { startLineNumber, startColumn, endLineNumber, endColumn };
	}
}

// --- diagnostics --- ---

export class DiagnostcsAdapter extends Adapter {

	private _disposables: IDisposable[] = [];
	private _listener: { [uri: string]: IDisposable } = Object.create(null);

	constructor(private _defaults: LanguageServiceDefaultsImpl, private _selector: string,
		worker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>
	) {
		super(worker);

		const onModelAdd = (model: monaco.editor.IModel): void => {
			if (model.getModeId() !== _selector) {
				return;
			}

			let handle: number;
			const changeSubscription = model.onDidChangeContent(() => {
				clearTimeout(handle);
				handle = setTimeout(() => this._doValidate(model.uri), 500);
			});

			this._listener[model.uri.toString()] = {
				dispose() {
					changeSubscription.dispose();
					clearTimeout(handle);
				}
			};

			this._doValidate(model.uri);
		};

		const onModelRemoved = (model: monaco.editor.IModel): void => {
			monaco.editor.setModelMarkers(model, this._selector, []);
			const key = model.uri.toString();
			if (this._listener[key]) {
				this._listener[key].dispose();
				delete this._listener[key];
			}
		};

		this._disposables.push(monaco.editor.onDidCreateModel(onModelAdd));
		this._disposables.push(monaco.editor.onWillDisposeModel(onModelRemoved));
		this._disposables.push(monaco.editor.onDidChangeModelLanguage(event => {
			onModelRemoved(event.model);
			onModelAdd(event.model);
		}));

		this._disposables.push({
			dispose() {
				for (const model of monaco.editor.getModels()) {
					onModelRemoved(model);
				}
			}
		});

		this._disposables.push(this._defaults.onDidChange(() => {
			// redo diagnostics when options change
			for (const model of monaco.editor.getModels()) {
				onModelRemoved(model);
				onModelAdd(model);
			}
		}));

		monaco.editor.getModels().forEach(onModelAdd);
	}

	public dispose(): void {
		this._disposables.forEach(d => d && d.dispose());
		this._disposables = [];
	}

	private _doValidate(resource: Uri): void {
		this._worker(resource).then(worker => {
			if (!monaco.editor.getModel(resource)) {
 				// model was disposed in the meantime
 				return null;
 			}
			const promises: Promise<ts.Diagnostic[]>[] = [];
			const {noSyntaxValidation, noSemanticValidation} = this._defaults.getDiagnosticsOptions();
			if (!noSyntaxValidation) {
				promises.push(worker.getSyntacticDiagnostics(resource.toString()));
			}
			if (!noSemanticValidation) {
				promises.push(worker.getSemanticDiagnostics(resource.toString()));
			}
			return Promise.join(promises);
		}).then(diagnostics => {
			if (!diagnostics || !monaco.editor.getModel(resource)) {
 				// model was disposed in the meantime
 				return null;
 			}
			const markers = diagnostics
				.reduce((p, c) => c.concat(p), [])
				.map(d => this._convertDiagnostics(resource, d));

			monaco.editor.setModelMarkers(monaco.editor.getModel(resource), this._selector, markers);
		}).done(undefined, err => {
			console.error(err);
		});
	}

	private _convertDiagnostics(resource: Uri, diag: ts.Diagnostic): monaco.editor.IMarkerData {
		const {lineNumber: startLineNumber, column: startColumn} = this._offsetToPosition(resource, diag.start);
		const {lineNumber: endLineNumber, column: endColumn} = this._offsetToPosition(resource, diag.start + diag.length);

		return {
			severity: monaco.Severity.Error,
			startLineNumber,
			startColumn,
			endLineNumber,
			endColumn,
			message: ts.flattenDiagnosticMessageText(diag.messageText, '\n')
		};
	}
}

// --- suggest ------

interface MyCompletionItem extends monaco.languages.CompletionItem {
	uri: Uri;
	position: Position;
	name: string;
	containerName?: string;
	navigation?: ts.NavigateToItem;
	skipCodeSnippet?: boolean;
}

interface TypescriptSnippet {
	prefix: string;
	body: string;
	description?: string;
}

export class SuggestAdapter extends Adapter implements monaco.languages.CompletionItemProvider {

	private typescriptSnippets: TypescriptSnippet[] = [];
	private exclusionMap: { [keyword: string]: number } = Object.create(null);

	constructor(worker: (first: Uri, ...more: Uri[]) => Promise<TypeScriptWorker>) {
		super(worker);

		this.exclusionMap['from'] = 1;
		this.exclusionMap['import'] = 1;
		this.exclusionMap['delete'] = 1;
		this.exclusionMap['with'] = 1;
		this.exclusionMap['await'] = 1;
		this.exclusionMap['try'] = 1;
		this.exclusionMap['catch'] = 1;
		this.exclusionMap['finally'] = 1;
		this.exclusionMap['yield'] = 1;
		this.exclusionMap['as'] = 1;
		this.exclusionMap['async'] = 1;
		this.exclusionMap['abstract'] = 1;
		this.exclusionMap['any'] = 1;
		this.exclusionMap['undefined'] = 1;
		this.exclusionMap['throw'] = 1;
		this.exclusionMap['symbol'] = 1;
		this.exclusionMap['super'] = 1;
		this.exclusionMap['require'] = 1;
		this.exclusionMap['readonly'] = 1;

		Object.keys(snippets).forEach((snippetKey) => {
			const snippet = (snippets as any)[snippetKey];
			const prefix = (snippet as any).prefix;
			const body =  (snippet as any).body.join('\n');
			const description = (snippet as any).description;
			this.typescriptSnippets.push({
				prefix: prefix,
				body: body,
				description: description
			})
		});
	}

	public get triggerCharacters(): string[] {
		return ['.'];
	}

	provideCompletionItems(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.CompletionItem[]> {
		const wordInfo = model.getWordUntilPosition(position);
		const resource = model.uri;
		const offset = this._positionToOffset(resource, position);

		const lineContent = model.getLineContent(position.lineNumber);
		const wordUnderCursor = model.getWordAtPosition(position);
		let wordBefore = '';
		let wordAfter = '';
		if (wordUnderCursor) {
			wordBefore = lineContent.substring(wordUnderCursor.startColumn - 1, position.column - 1);
			wordAfter = lineContent.substring(position.column - 1, wordUnderCursor.endColumn - 1);
		}
		const lineContentBefore = lineContent.substr(0, position.column - 1);
		const lineContentAfter = lineContent.substr(position.column - 1);

		let isNamespace = false;
		const prevWordInfo = model.getWordUntilPosition(new Position(position.lineNumber, wordInfo.startColumn - 1));
		if (prevWordInfo && prevWordInfo.word && prevWordInfo.word != "")
			isNamespace = true;

		return wireCancellationToken(token, this._worker(resource).then(worker => {
			let promises: Promise<any>[] = [];
			promises.push(worker.getCompletionsAtPosition(resource.toString(), offset));
			let promise = worker.getNavigateToItems(wordInfo.word).then(navigation => {
				if (!navigation || navigation.length == 0) return [];
				function convert(bucket: MyCompletionItem[], entry: ts.NavigateToItem): void {
					let label = entry.containerName ? entry.containerName + '.' + entry.name : entry.name;
					let result: MyCompletionItem = {
						uri: resource,
						position: position,
						label: label,
						name: entry.name,
						sortText: entry.name,
						filterText: (isNamespace ? prevWordInfo.word + "." : (entry.containerName ? entry.containerName + "." : "")) + entry.name,
						kind: SuggestAdapter.convertKind(entry.kind),
						containerName: entry.containerName,
						navigation: entry,
						skipCodeSnippet: lineContentAfter.trim() != "",
						insertText: {
							value: (isNamespace ? prevWordInfo.word + "." : (entry.containerName ? entry.containerName + "." : "")) + entry.name,
						},
						range: new monaco.Range(position.lineNumber,
								position.column - wordInfo.word.length - (isNamespace ? prevWordInfo.word.length + 1 : 0),
								position.lineNumber,
								position.column)
					};
					bucket.push(result);
				}
				let result: MyCompletionItem[] = [];
				navigation
					.filter(item => (item.kind == Kind.function && item.kindModifiers != "")
						&& (isNamespace ? item.containerName != prevWordInfo.word : true))
					.forEach(item => convert(result, item));
				return result;
			})
			promises.push(promise);
			return Promise.join(promises);
		}).then(values => {
			if (!values) {
				return;
			}
			let info: ts.CompletionInfo = values[0];
			let moreinfo: MyCompletionItem[] = values[1];
			if (!info) {
				return;
			}
			let suggestions: MyCompletionItem[] = info.entries
				.filter(entry => !this.exclusionMap[entry.name])
				.map(entry => {
					return {
						uri: resource,
						position: position,
						label: entry.name,
						name: entry.name,
						sortText: entry.sortText,
						kind: SuggestAdapter.convertKind(entry.kind),
						skipCodeSnippet: lineContentAfter.trim() != ""
					};
				});
			if (moreinfo) {
				suggestions = suggestions.concat(moreinfo);
			}
			return suggestions;
		}));
	}

	resolveCompletionItem(item: monaco.languages.CompletionItem, token: CancellationToken): Thenable<monaco.languages.CompletionItem> {
		let myItem = <MyCompletionItem>item;
		const resource = myItem.uri;
		const position = myItem.position;

		let entry: TypescriptSnippet = this.typescriptSnippets.filter(snippet => snippet.prefix == myItem.label)[0];
		if (entry) {
			return new Promise<monaco.languages.CompletionItem>((resolve, reject) => {
				myItem.insertText = {
					value: entry.body
				}
				myItem.documentation = entry.description;
				resolve(myItem);
			})
		}

		return wireCancellationToken(token, this._worker(resource).then(worker => {
			if (myItem.navigation) {
				return worker.getCompletionEntryDetailsAndSnippet(myItem.navigation.fileName,
					myItem.navigation.textSpan.start,
					myItem.name, myItem.label);
			} else {
				return worker.getCompletionEntryDetailsAndSnippet(resource.toString(),
					this._positionToOffset(resource, position),
					myItem.name, myItem.label);
			}
		}).then(values => {
			if (!values) {
				return myItem;
			}
			let details: ts.CompletionEntryDetails = values[0];
			let codeSnippet: string = values[1];
			if (!details) {
				return myItem;
			}
			myItem.uri = resource;
			myItem.position = position;
			myItem.kind = SuggestAdapter.convertKind(details.kind);
			myItem.detail = ts.displayPartsToString(details.displayParts);
			myItem.documentation = ts.displayPartsToString(details.documentation);
			myItem.insertText = !myItem.skipCodeSnippet ? {value: codeSnippet} : null;
			return myItem;
		}));
	}

	private static convertKind(kind: string): monaco.languages.CompletionItemKind {
		switch (kind) {
			case Kind.primitiveType:
			case Kind.keyword:
				return monaco.languages.CompletionItemKind.Keyword;
			case Kind.variable:
			case Kind.localVariable:
				return monaco.languages.CompletionItemKind.Variable;
			case Kind.memberVariable:
			case Kind.memberGetAccessor:
			case Kind.memberSetAccessor:
				return monaco.languages.CompletionItemKind.Field;
			case Kind.function:
			case Kind.memberFunction:
			case Kind.constructSignature:
			case Kind.callSignature:
			case Kind.indexSignature:
				return monaco.languages.CompletionItemKind.Function;
			case Kind.enum:
				return monaco.languages.CompletionItemKind.Enum;
			case Kind.module:
				return monaco.languages.CompletionItemKind.Module;
			case Kind.class:
				return monaco.languages.CompletionItemKind.Class;
			case Kind.interface:
				return monaco.languages.CompletionItemKind.Interface;
			case Kind.warning:
				return monaco.languages.CompletionItemKind.File;
		}

		return monaco.languages.CompletionItemKind.Property;
	}
}

export class SignatureHelpAdapter extends Adapter implements monaco.languages.SignatureHelpProvider {

	public signatureHelpTriggerCharacters = ['(', ','];

	provideSignatureHelp(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.SignatureHelp> {
		let resource = model.uri;
		return wireCancellationToken(token, this._worker(resource).then(worker => worker.getSignatureHelpItems(resource.toString(), this._positionToOffset(resource, position))).then(info => {

			if (!info) {
				return;
			}

			let ret: monaco.languages.SignatureHelp = {
				activeSignature: info.selectedItemIndex,
				activeParameter: info.argumentIndex,
				signatures: []
			};

			info.items.forEach(item => {

				let signature: monaco.languages.SignatureInformation = {
					label: '',
					documentation: null,
					parameters: []
				};

				signature.label += ts.displayPartsToString(item.prefixDisplayParts);
				item.parameters.forEach((p, i, a) => {
					let label = ts.displayPartsToString(p.displayParts);
					let parameter: monaco.languages.ParameterInformation = {
						label: label,
						documentation: ts.displayPartsToString(p.documentation)
					};
					signature.label += label;
					signature.parameters.push(parameter);
					if (i < a.length - 1) {
						signature.label += ts.displayPartsToString(item.separatorDisplayParts);
					}
				});
				signature.label += ts.displayPartsToString(item.suffixDisplayParts);
				ret.signatures.push(signature);
			});

			return ret;

		}));
	}
}

// --- hover ------

export class QuickInfoAdapter extends Adapter implements monaco.languages.HoverProvider {

	provideHover(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Hover> {
		let resource = model.uri;
		const wordInfo = model.getWordAtPosition(position);

		return wireCancellationToken(token, this._worker(resource).then(worker => {
			let promises: Promise<any>[] = [];
			promises.push(worker.getQuickInfoAtPosition(resource.toString(), this._positionToOffset(resource, position)));
			promises.push(worker.getSignatureHelpItems(resource.toString(), this._positionToOffset(resource, position)));
			if (wordInfo)
				promises.push(worker.getCompletionEntryDetails(resource.toString(), this._positionToOffset(resource, position), wordInfo.word));
			return Promise.join(promises);
		}).then(values => {
			if (!values) {
				return;
			}
			let info: ts.QuickInfo = values[0];
			let signature: ts.SignatureHelpItems = values[1];
			let completion: ts.CompletionEntryDetails = values[2];
			if (info && completion) {
				let contents = ts.displayPartsToString(completion.documentation);
				if (!contents)
					contents = ts.displayPartsToString(info.displayParts);
				return {
					range: this._textSpanToRange(resource, info.textSpan),
					contents: [contents]
				};
			} else if (signature && signature.items[0]) {
				if (signature.items[0].parameters.length > 0) {
					let activeParameter = signature.argumentIndex;
					let contents = ts.displayPartsToString(signature.items[0].parameters[activeParameter].documentation);
					if (!contents)
						contents = ts.displayPartsToString(signature.items[0].parameters[activeParameter].displayParts);
					let parameterSpan = signature.applicableSpan;
					if (signature.argumentCount > 1) {
						let parametersStr = model.getValue().substr(signature.applicableSpan.start, signature.applicableSpan.length);
						let parametersSplit = parametersStr.split(',');
						parameterSpan.start = parameterSpan.start + parametersStr.indexOf(parametersSplit[activeParameter]);
						parameterSpan.length = parametersSplit[activeParameter].length;
					}
					return {
						range: this._textSpanToRange(resource, parameterSpan),
						contents: [contents]
					};
				}
			} else if (info) {
				let contents = ts.displayPartsToString(info.displayParts);
				return {
					range: this._textSpanToRange(resource, info.textSpan),
					contents: [contents]
				};
			}
			return;
		}));
	}
}

// --- occurrences ------

export class OccurrencesAdapter extends Adapter implements monaco.languages.DocumentHighlightProvider {

	public provideDocumentHighlights(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.DocumentHighlight[]> {
		const resource = model.uri;

		return wireCancellationToken(token, this._worker(resource).then(worker => {
			return worker.getOccurrencesAtPosition(resource.toString(), this._positionToOffset(resource, position));
		}).then(entries => {
			if (!entries) {
				return;
			}
			return entries.map(entry => {
				return <monaco.languages.DocumentHighlight>{
					range: this._textSpanToRange(resource, entry.textSpan),
					kind: entry.isWriteAccess ? monaco.languages.DocumentHighlightKind.Write : monaco.languages.DocumentHighlightKind.Text
				};
			});
		}));
	}
}

// --- definition ------

export class DefinitionAdapter extends Adapter {

	public provideDefinition(model: monaco.editor.IReadOnlyModel, position: Position, token: CancellationToken): Thenable<monaco.languages.Definition> {
		const resource = model.uri;

		return wireCancellationToken(token, this._worker(resource).then(worker => {
			return worker.getDefinitionAtPosition(resource.toString(), this._positionToOffset(resource, position));
		}).then(entries => {
			if (!entries) {
				return;
			}
			const result: monaco.languages.Location[] = [];
			for (let entry of entries) {
				const uri = Uri.parse(entry.fileName);
				if (monaco.editor.getModel(uri)) {
					result.push({
						uri: uri,
						range: this._textSpanToRange(uri, entry.textSpan)
					});
				}
			}
			return result;
		}));
	}
}

// --- references ------

export class ReferenceAdapter extends Adapter implements monaco.languages.ReferenceProvider {

	provideReferences(model: monaco.editor.IReadOnlyModel, position: Position, context: monaco.languages.ReferenceContext, token: CancellationToken): Thenable<monaco.languages.Location[]> {
		const resource = model.uri;

		return wireCancellationToken(token, this._worker(resource).then(worker => {
			return worker.getReferencesAtPosition(resource.toString(), this._positionToOffset(resource, position));
		}).then(entries => {
			if (!entries) {
				return;
			}
			const result: monaco.languages.Location[] = [];
			for (let entry of entries) {
				const uri = Uri.parse(entry.fileName);
				if (monaco.editor.getModel(uri)) {
					result.push({
						uri: uri,
						range: this._textSpanToRange(uri, entry.textSpan)
					});
				}
			}
			return result;
		}));
	}
}

// --- outline ------

export class OutlineAdapter extends Adapter implements monaco.languages.DocumentSymbolProvider {

	public provideDocumentSymbols(model: monaco.editor.IReadOnlyModel, token: CancellationToken): Thenable<monaco.languages.SymbolInformation[]> {
		const resource = model.uri;

		return wireCancellationToken(token, this._worker(resource).then(worker => worker.getNavigationBarItems(resource.toString())).then(items => {
			if (!items) {
				return;
			}

			const convert = (bucket: monaco.languages.SymbolInformation[], item: ts.NavigationBarItem, containerLabel?: string): void => {
				let result: monaco.languages.SymbolInformation = {
					name: item.text,
					kind: outlineTypeTable[item.kind] || monaco.languages.SymbolKind.Variable,
					location: {
						uri: resource,
						range: this._textSpanToRange(resource, item.spans[0])
					},
					containerName: containerLabel
				};

				if (item.childItems && item.childItems.length > 0) {
					for (let child of item.childItems) {
						convert(bucket, child, result.name);
					}
				}

				bucket.push(result);
			}

			let result: monaco.languages.SymbolInformation[] = [];
			items.forEach(item => convert(result, item));
			return result;
		}));
	}
}

export class Kind {
	public static unknown: string = '';
	public static keyword: string = 'keyword';
	public static script: string = 'script';
	public static module: string = 'module';
	public static class: string = 'class';
	public static interface: string = 'interface';
	public static type: string = 'type';
	public static enum: string = 'enum';
	public static variable: string = 'var';
	public static localVariable: string = 'local var';
	public static function: string = 'function';
	public static localFunction: string = 'local function';
	public static memberFunction: string = 'method';
	public static memberGetAccessor: string = 'getter';
	public static memberSetAccessor: string = 'setter';
	public static memberVariable: string = 'property';
	public static constructorImplementation: string = 'constructor';
	public static callSignature: string = 'call';
	public static indexSignature: string = 'index';
	public static constructSignature: string = 'construct';
	public static parameter: string = 'parameter';
	public static typeParameter: string = 'type parameter';
	public static primitiveType: string = 'primitive type';
	public static label: string = 'label';
	public static alias: string = 'alias';
	public static const: string = 'const';
	public static let: string = 'let';
	public static warning: string = 'warning';
}

let outlineTypeTable: { [kind: string]: monaco.languages.SymbolKind } = Object.create(null);
outlineTypeTable[Kind.module] = monaco.languages.SymbolKind.Module;
outlineTypeTable[Kind.class] = monaco.languages.SymbolKind.Class;
outlineTypeTable[Kind.enum] = monaco.languages.SymbolKind.Enum;
outlineTypeTable[Kind.interface] = monaco.languages.SymbolKind.Interface;
outlineTypeTable[Kind.memberFunction] = monaco.languages.SymbolKind.Method;
outlineTypeTable[Kind.memberVariable] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.memberGetAccessor] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.memberSetAccessor] = monaco.languages.SymbolKind.Property;
outlineTypeTable[Kind.variable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.const] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.localVariable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.variable] = monaco.languages.SymbolKind.Variable;
outlineTypeTable[Kind.function] = monaco.languages.SymbolKind.Function;
outlineTypeTable[Kind.localFunction] = monaco.languages.SymbolKind.Function;

// --- formatting ----

export abstract class FormatHelper extends Adapter {
	protected static _convertOptions(options: monaco.languages.FormattingOptions): ts.FormatCodeOptions {
		return {
			ConvertTabsToSpaces: options.insertSpaces,
			TabSize: options.tabSize,
			IndentSize: options.tabSize,
			IndentStyle: ts.IndentStyle.Smart,
			NewLineCharacter: '\n',
			InsertSpaceAfterCommaDelimiter: true,
			InsertSpaceAfterSemicolonInForStatements: true,
			InsertSpaceBeforeAndAfterBinaryOperators: true,
			InsertSpaceAfterKeywordsInControlFlowStatements: true,
			InsertSpaceAfterFunctionKeywordForAnonymousFunctions: true,
			InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
			InsertSpaceAfterOpeningAndBeforeClosingNonemptyBrackets: false,
			InsertSpaceAfterOpeningAndBeforeClosingTemplateStringBraces: false,
			PlaceOpenBraceOnNewLineForControlBlocks: false,
			PlaceOpenBraceOnNewLineForFunctions: false
		};
	}

	protected _convertTextChanges(uri: Uri, change: ts.TextChange): monaco.editor.ISingleEditOperation {
		return <monaco.editor.ISingleEditOperation>{
			text: change.newText,
			range: this._textSpanToRange(uri, change.span)
		};
	}
}

export class FormatAdapter extends FormatHelper implements monaco.languages.DocumentRangeFormattingEditProvider {

	provideDocumentRangeFormattingEdits(model: monaco.editor.IReadOnlyModel, range: Range, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
		const resource = model.uri;

		return wireCancellationToken(token, this._worker(resource).then(worker => {
			return worker.getFormattingEditsForRange(resource.toString(),
				this._positionToOffset(resource, { lineNumber: range.startLineNumber, column: range.startColumn }),
				this._positionToOffset(resource, { lineNumber: range.endLineNumber, column: range.endColumn }),
				FormatHelper._convertOptions(options));
		}).then(edits => {
			if (edits) {
				return edits.map(edit => this._convertTextChanges(resource, edit));
			}
		}));
	}
}

export class FormatOnTypeAdapter extends FormatHelper implements monaco.languages.OnTypeFormattingEditProvider {

	get autoFormatTriggerCharacters() {
		return [';', '}', '\n'];
	}

	provideOnTypeFormattingEdits(model: monaco.editor.IReadOnlyModel, position: Position, ch: string, options: monaco.languages.FormattingOptions, token: CancellationToken): Thenable<monaco.editor.ISingleEditOperation[]> {
		const resource = model.uri;

		return wireCancellationToken(token, this._worker(resource).then(worker => {
			return worker.getFormattingEditsAfterKeystroke(resource.toString(),
				this._positionToOffset(resource, position),
				ch, FormatHelper._convertOptions(options));
		}).then(edits => {
			if (edits) {
				return edits.map(edit => this._convertTextChanges(resource, edit));
			}
		}));
	}
}

/**
 * Hook a cancellation token to a WinJS Promise
 */
function wireCancellationToken<T>(token: CancellationToken, promise: Promise<T>): Thenable<T> {
	token.onCancellationRequested(() => promise.cancel());
	return promise;
}
