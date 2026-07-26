'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const AdmZip = require('adm-zip');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';
const WORD_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const PRESENTATION_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const DRAWING_NAMESPACES = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const MAX_ENTRY_SIZE = 16 * 1024 * 1024;
const MAX_TOTAL_SIZE = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_XML_DEPTH = 256;
const MAX_XML_NODES = 1_000_000;

const orderedParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

class WorkerBudget {
  constructor(budget) {
    this.budget = budget;
    this.blocks = 0;
    this.chars = 0;
    this.tokens = 0;
    this.nodes = 0;
  }

  visitElement(localName, namespaceUri, depth, enforceOutputBudget) {
    this.nodes += 1;
    if (this.nodes > MAX_XML_NODES) {
      throw new Error('OOXML XML node limit exceeded');
    }
    if (depth > MAX_XML_DEPTH) {
      throw new Error('OOXML XML depth limit exceeded');
    }
    if (
      enforceOutputBudget &&
      ((WORD_NAMESPACES.has(namespaceUri) &&
        (localName === 'p' || localName === 'tbl')) ||
        (PRESENTATION_NAMESPACES.has(namespaceUri) && localName === 'sp') ||
        (DRAWING_NAMESPACES.has(namespaceUri) && localName === 'tbl'))
    ) {
      this.blocks += 1;
      if (this.blocks > this.budget.max_blocks) {
        throw new Error('Parser budget exceeded: blocks');
      }
    }
  }

  visitText(text, enforceOutputBudget) {
    if (!enforceOutputBudget) return;
    this.chars += text.length;
    if (this.chars > this.budget.max_chars) {
      throw new Error('Parser budget exceeded: chars');
    }
    this.tokens += Array.from(text).filter(
      (character) => !/\s/u.test(character),
    ).length;
    if (this.tokens > this.budget.max_tokens) {
      throw new Error('Parser budget exceeded: tokens');
    }
  }
}

function parseXmlPart(xml, options, budget, enforceOutputBudget) {
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    throw new Error('OOXML document type declarations are not allowed');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error('OOXML part contains malformed XML');
  }
  const parsed = orderedParser.parse(xml);
  if (!Array.isArray(parsed)) {
    throw new Error('OOXML part has no document element');
  }
  const rootNode = parsed.find(isElementNode);
  if (!rootNode) throw new Error('OOXML part has no document element');
  const root = buildElement(
    rootNode,
    new Map([['xml', XML_NAMESPACE_URI]]),
    'default',
    budget,
    enforceOutputBudget,
    1,
  );
  if (
    root.local_name !== options.root_local_name ||
    !options.root_namespace_uris.includes(root.namespace_uri || '')
  ) {
    throw new Error(
      `OOXML root namespace is invalid for ${options.root_local_name}`,
    );
  }
  return root;
}

function buildElement(
  node,
  inheritedNamespaces,
  inheritedXmlSpace,
  budget,
  enforceOutputBudget,
  depth,
) {
  const tagName = Object.keys(node).find(
    (key) => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'),
  );
  if (!tagName) throw new Error('OOXML contains an invalid element');
  const rawAttributes = isRecord(node[':@']) ? node[':@'] : {};
  const namespaces = new Map(inheritedNamespaces);
  for (const [rawName, rawValue] of Object.entries(rawAttributes)) {
    const name = rawName.replace(/^@_/, '');
    if (name === 'xmlns') {
      namespaces.set('', String(rawValue));
    } else if (name.startsWith('xmlns:')) {
      const prefix = name.slice('xmlns:'.length);
      const namespaceUri = String(rawValue);
      if (prefix === 'xml' && namespaceUri !== XML_NAMESPACE_URI) {
        throw new Error('OOXML contains an invalid xml namespace declaration');
      }
      namespaces.set(prefix, namespaceUri);
    }
  }

  const elementName = resolveQualifiedName(tagName, namespaces, true);
  budget.visitElement(
    elementName.localName,
    elementName.namespaceUri,
    depth,
    enforceOutputBudget,
  );
  const attributes = [];
  for (const [rawName, rawValue] of Object.entries(rawAttributes)) {
    const name = rawName.replace(/^@_/, '');
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const resolved = resolveQualifiedName(name, namespaces, false);
    attributes.push({
      local_name: resolved.localName,
      namespace_uri: resolved.namespaceUri,
      value: xmlScalarString(rawValue),
    });
  }
  const declaredXmlSpace = attributes.find(
    (attribute) =>
      attribute.local_name === 'space' &&
      attribute.namespace_uri === XML_NAMESPACE_URI,
  )?.value;
  if (
    declaredXmlSpace !== undefined &&
    declaredXmlSpace !== 'default' &&
    declaredXmlSpace !== 'preserve'
  ) {
    throw new Error('OOXML contains an invalid xml:space value');
  }
  const effectiveXmlSpace = declaredXmlSpace || inheritedXmlSpace;

  const rawContent = node[tagName];
  const content = [];
  if (Array.isArray(rawContent)) {
    for (const child of rawContent) {
      if (!isRecord(child)) continue;
      if ('#text' in child) {
        const text = xmlScalarString(child['#text']);
        budget.visitText(text, enforceOutputBudget);
        content.push(text);
        continue;
      }
      if ('#cdata' in child) {
        const text = extractCdata(child['#cdata']);
        budget.visitText(text, enforceOutputBudget);
        content.push(text);
        continue;
      }
      if (isElementNode(child)) {
        content.push(
          buildElement(
            child,
            namespaces,
            effectiveXmlSpace,
            budget,
            enforceOutputBudget,
            depth + 1,
          ),
        );
      }
    }
  }

  return {
    local_name: elementName.localName,
    namespace_uri: elementName.namespaceUri,
    attributes,
    effective_xml_space: effectiveXmlSpace,
    content,
  };
}

function resolveQualifiedName(
  qualifiedName,
  namespaces,
  defaultNamespaceApplies,
) {
  const separator = qualifiedName.indexOf(':');
  if (separator < 0) {
    return {
      localName: qualifiedName,
      namespaceUri: defaultNamespaceApplies
        ? namespaces.get('') || null
        : null,
    };
  }
  const prefix = qualifiedName.slice(0, separator);
  const namespaceUri = namespaces.get(prefix);
  if (!namespaceUri) {
    throw new Error(`OOXML namespace prefix is not declared: ${prefix}`);
  }
  return {
    localName: qualifiedName.slice(separator + 1),
    namespaceUri,
  };
}

function extractCdata(value) {
  if (!Array.isArray(value)) return xmlScalarString(value);
  return value
    .filter(isRecord)
    .map((entry) => xmlScalarString(entry['#text']))
    .join('');
}

function xmlScalarString(value) {
  if (value === null || value === undefined) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  throw new Error('OOXML contains a non-scalar text value');
}

function isElementNode(value) {
  return (
    isRecord(value) &&
    Object.keys(value).some(
      (key) => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'),
    )
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateArchive(zip, budget, sourceBytes) {
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) {
    throw new Error('OOXML archive has too many entries');
  }
  const normalizedEntryNames = new Set();
  let totalSize = 0;
  for (const entry of entries) {
    const normalizedEntryName = normalizeEntryName(entry.entryName);
    if (normalizedEntryNames.has(normalizedEntryName)) {
      throw new Error(
        `duplicate OOXML archive entry: ${normalizedEntryName}`,
      );
    }
    normalizedEntryNames.add(normalizedEntryName);
    assertLocalAndCentralNamesMatch(entry, sourceBytes);
    const size = entry.header.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_SIZE) {
      throw new Error('OOXML archive entry exceeds its size limit');
    }
    totalSize += size;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error('OOXML archive exceeds its uncompressed size limit');
    }
  }
  const requestedSlides = workerData.requests.filter((request) =>
    /^ppt\/slides\/[^/]+\.xml$/.test(request.entry_name),
  ).length;
  if (requestedSlides > budget.max_slides) {
    throw new Error('Parser budget exceeded: slides');
  }
  return entries;
}

function normalizeEntryName(entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0) {
    throw new Error('OOXML archive contains an invalid entry name');
  }
  return entryName.normalize('NFC');
}

function assertLocalAndCentralNamesMatch(entry, sourceBytes) {
  const localHeaderOffset = entry.header.offset;
  const localHeaderSize = 30;
  if (
    !Number.isSafeInteger(localHeaderOffset) ||
    localHeaderOffset < 0 ||
    localHeaderOffset + localHeaderSize > sourceBytes.length ||
    sourceBytes.readUInt32LE(localHeaderOffset) !== 0x04034b50
  ) {
    throw new Error('OOXML archive contains an invalid local file header');
  }
  const localNameLength = sourceBytes.readUInt16LE(localHeaderOffset + 26);
  const localNameStart = localHeaderOffset + localHeaderSize;
  const localNameEnd = localNameStart + localNameLength;
  if (localNameEnd > sourceBytes.length) {
    throw new Error('OOXML archive contains a truncated local file name');
  }
  const localName = sourceBytes.subarray(localNameStart, localNameEnd);
  const centralName = Buffer.from(entry.rawEntryName);
  if (!localName.equals(centralName)) {
    throw new Error(
      `OOXML archive local and central directory names differ: ${entry.entryName}`,
    );
  }
}

function run() {
  const sourceBytes = Buffer.from(workerData.source_bytes);
  if (sourceBytes.length > workerData.budget.max_bytes) {
    throw new Error('Parser budget exceeded: bytes');
  }
  const zip = new AdmZip(sourceBytes);
  const budget = new WorkerBudget(workerData.budget);
  const entries = validateArchive(zip, workerData.budget, sourceBytes);
  const exactEntries = new Map(
    entries.map((entry) => [entry.entryName, entry]),
  );
  const parts = {};
  const seenRequests = new Set();
  for (const request of workerData.requests) {
    if (seenRequests.has(request.entry_name)) {
      throw new Error(`Duplicate OOXML part request: ${request.entry_name}`);
    }
    seenRequests.add(request.entry_name);
    const entry = exactEntries.get(request.entry_name);
    if (!entry) {
      if (request.required) {
        throw new Error(`OOXML is missing ${request.entry_name}`);
      }
      parts[request.entry_name] = null;
      continue;
    }
    const xml = entry.getData().toString('utf8');
    parts[request.entry_name] = parseXmlPart(
      xml,
      request,
      budget,
      request.enforce_output_budget,
    );
  }
  return {
    entry_names: entries.map((entry) => entry.entryName),
    parts,
  };
}

try {
  parentPort.postMessage({ ok: true, result: run() });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    },
  });
}
