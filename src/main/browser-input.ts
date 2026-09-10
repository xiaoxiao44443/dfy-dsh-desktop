// These functions execute in the focused frame's own realm. The transaction
// retains its target so a focus change cannot redirect the verification.
export const ACTIVE_INPUT_EXPRESSION = `(() => {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
})()`

export const PREPARE_BROWSER_INPUT = String.raw`function(text, clear) {
  const element = this;
  const doc = element.ownerDocument;
  let active = doc?.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  if (!element.isConnected || active !== element) return { error: '输入目标已失去焦点。' };
  if (element.disabled || element.readOnly || element.getAttribute('aria-disabled') === 'true'
      || element.getAttribute('aria-readonly') === 'true') return { error: '输入目标不可编辑。' };
  const normalize = (value) => value.replace(/\r\n?/g, '\n');
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element instanceof HTMLInputElement && !['text', 'search', 'tel', 'url', 'password', 'email', 'number'].includes(element.type)) {
      return { error: '当前输入类型不支持文本输入。' };
    }
    if (clear) element.select();
    const value = element.value;
    const start = clear ? 0 : element.selectionStart ?? value.length;
    const end = clear ? value.length : element.selectionEnd ?? value.length;
    const inserted = element instanceof HTMLTextAreaElement ? normalize(text) : text.replace(/[\r\n]/g, '');
    return { expected: value.slice(0, start) + inserted + value.slice(end), kind: 'value' };
  }
  if (!element.isContentEditable) return { error: '当前焦点元素不可输入文本。' };
  const selection = element.getRootNode().getSelection?.() ?? doc.getSelection();
  if (!selection) return { error: '无法读取输入目标的文字选区。' };
  if (clear) {
    const range = doc.createRange(); range.selectNodeContents(element);
    selection.removeAllRanges(); selection.addRange(range);
  }
  if (selection.rangeCount !== 1) return { error: '无法读取输入目标的文字选区。' };
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return { error: '文字选区不属于当前输入目标。' };
  const before = doc.createRange(); before.selectNodeContents(element); before.setEnd(range.startContainer, range.startOffset);
  const after = doc.createRange(); after.selectNodeContents(element); after.setStart(range.endContainer, range.endOffset);
  const saved = range.cloneRange();
  const renderedText = (part) => {
    selection.removeAllRanges(); selection.addRange(part);
    return selection.toString();
  };
  const expected = normalize(renderedText(before) + text + renderedText(after));
  selection.removeAllRanges(); selection.addRange(saved);
  return { expected, kind: 'contenteditable' };
}`

export const VERIFY_BROWSER_INPUT = String.raw`async function(expected, kind) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (!this.isConnected) return false;
  if (kind === 'value') return this.value === expected;
  const normalize = (value) => value.replace(/\r\n?/g, '\n');
  const selection = this.getRootNode().getSelection?.() ?? this.ownerDocument.getSelection();
  if (!selection) return false;
  const saved = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange());
  const range = this.ownerDocument.createRange(); range.selectNodeContents(this);
  selection.removeAllRanges(); selection.addRange(range);
  const actual = normalize(selection.toString());
  selection.removeAllRanges(); for (const previous of saved) selection.addRange(previous);
  return actual === expected;
}`
