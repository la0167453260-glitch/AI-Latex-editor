
export interface Item {
  type: string;
  code: string;
}

export interface Cursor {
  line: number;
  ch: number;
}

export interface Doc {
  replaceRange: (text: string, cursor: Cursor) => void;
  setCursor: (cursor: Cursor) => void;
  getCursor: () => Cursor;
}

export const handleItem = (item: Item, doc: Doc) => {
  const cur = doc.getCursor();
  if (item.type === 'env') {
    const isList = item.code === 'itemize' || item.code === 'enumerate';
    // Add [scale=1] option for tikzpicture environment
    const extra = item.code === 'tikzpicture' ? '[scale=1]' : '';
    const snippet = isList
      ? `\\begin{${item.code}}${extra}\n  \\item \n\\end{${item.code}}`
      : `\\begin{${item.code}}${extra}\n  \n\\end{${item.code}}`;
    doc.replaceRange(snippet, cur);
    doc.setCursor({ line: cur.line + 1, ch: isList ? 8 : 2 });
  } else if (item.type === 'action') {
    // Placeholder for other actions
  }
};
