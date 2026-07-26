const emptyDocument = { sections: [], content_text: '' };

export function parseDocx() {
  return Promise.resolve(emptyDocument);
}

export function parsePdf() {
  return Promise.resolve(emptyDocument);
}

export function parsePptx() {
  return Promise.resolve(emptyDocument);
}

export function parseTxt() {
  return Promise.resolve(emptyDocument);
}
