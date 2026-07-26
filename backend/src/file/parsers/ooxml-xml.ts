import { XMLParser, XMLValidator } from 'fast-xml-parser';

const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';

export const OOXML_NAMESPACES = {
  wordprocessing: [
    'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'http://purl.oclc.org/ooxml/wordprocessingml/main',
  ],
  presentation: [
    'http://schemas.openxmlformats.org/presentationml/2006/main',
    'http://purl.oclc.org/ooxml/presentationml/main',
  ],
  drawing: [
    'http://schemas.openxmlformats.org/drawingml/2006/main',
    'http://purl.oclc.org/ooxml/drawingml/main',
  ],
  officeRelationships: [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'http://purl.oclc.org/ooxml/officeDocument/relationships',
  ],
  packageRelationships: [
    'http://schemas.openxmlformats.org/package/2006/relationships',
    'http://purl.oclc.org/ooxml/package/relationships',
  ],
} as const;

export interface NamespaceAttribute {
  local_name: string;
  namespace_uri: string | null;
  value: string;
}

export interface NamespaceElement {
  local_name: string;
  namespace_uri: string | null;
  attributes: NamespaceAttribute[];
  effective_xml_space: 'default' | 'preserve';
  content: Array<NamespaceElement | string>;
}

interface ParseXmlPartOptions {
  root_local_name: string;
  root_namespace_uris: readonly string[];
}

const orderedParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

export function parseXmlPart(
  xml: string,
  options: ParseXmlPartOptions,
): NamespaceElement {
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(xml)) {
    throw new Error('OOXML document type declarations are not allowed');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error('OOXML part contains malformed XML');
  }
  const parsed: unknown = orderedParser.parse(xml);
  if (!Array.isArray(parsed)) {
    throw new Error('OOXML part has no document element');
  }
  const rootNode = parsed.find(isElementNode);
  if (!rootNode) throw new Error('OOXML part has no document element');
  const root = buildElement(
    rootNode,
    new Map<string, string>([['xml', XML_NAMESPACE_URI]]),
    'default',
  );
  if (
    root.local_name !== options.root_local_name ||
    !options.root_namespace_uris.includes(root.namespace_uri ?? '')
  ) {
    throw new Error(
      `OOXML root namespace is invalid for ${options.root_local_name}`,
    );
  }
  return root;
}

export function childElements(
  element: NamespaceElement,
  namespaceUris?: readonly string[],
  localName?: string,
): NamespaceElement[] {
  return element.content.filter(
    (child): child is NamespaceElement =>
      typeof child !== 'string' &&
      (!namespaceUris || namespaceUris.includes(child.namespace_uri ?? '')) &&
      (!localName || child.local_name === localName),
  );
}

export function descendantElements(
  element: NamespaceElement,
  namespaceUris: readonly string[],
  localName: string,
): NamespaceElement[] {
  return [...iterateDescendantElements(element, namespaceUris, localName)];
}

export function* iterateDescendantElements(
  element: NamespaceElement,
  namespaceUris: readonly string[],
  localName: string,
): Generator<NamespaceElement> {
  for (const child of element.content) {
    if (typeof child === 'string') continue;
    if (
      child.local_name === localName &&
      namespaceUris.includes(child.namespace_uri ?? '')
    ) {
      yield child;
    }
    yield* iterateDescendantElements(child, namespaceUris, localName);
  }
}

export function firstDescendant(
  element: NamespaceElement,
  namespaceUris: readonly string[],
  localName: string,
): NamespaceElement | undefined {
  const pending = [element];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (!current) continue;
    for (const child of current.content) {
      if (typeof child === 'string') continue;
      if (
        child.local_name === localName &&
        namespaceUris.includes(child.namespace_uri ?? '')
      ) {
        return child;
      }
      pending.push(child);
    }
  }
  return undefined;
}

export function attributeValue(
  element: NamespaceElement | undefined,
  localName: string,
  namespaceUris: readonly (string | null)[],
): string | null {
  const attribute = element?.attributes.find(
    (candidate) =>
      candidate.local_name === localName &&
      namespaceUris.includes(candidate.namespace_uri),
  );
  return attribute?.value ?? null;
}

export function elementText(element: NamespaceElement): string {
  let text = '';
  const visit = (current: NamespaceElement): void => {
    for (const child of current.content) {
      if (typeof child === 'string') text += child;
      else visit(child);
    }
  };
  visit(element);
  return text;
}

export function hasEffectiveXmlSpacePreserve(
  element: NamespaceElement,
): boolean {
  const pending: NamespaceElement[] = [element];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    if (!current) continue;
    if (
      current.effective_xml_space === 'preserve' &&
      current.content.some(
        (child) => typeof child === 'string' && child.length > 0,
      )
    ) {
      return true;
    }
    for (const child of current.content) {
      if (typeof child !== 'string') {
        pending.push(child);
      }
    }
  }
  return false;
}

function buildElement(
  node: Record<string, unknown>,
  inheritedNamespaces: ReadonlyMap<string, string>,
  inheritedXmlSpace: 'default' | 'preserve',
): NamespaceElement {
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
  const attributes: NamespaceAttribute[] = [];
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
  const effectiveXmlSpace = declaredXmlSpace ?? inheritedXmlSpace;

  const rawContent = node[tagName];
  const content: Array<NamespaceElement | string> = [];
  if (Array.isArray(rawContent)) {
    for (const child of rawContent) {
      if (!isRecord(child)) continue;
      if ('#text' in child) {
        content.push(xmlScalarString(child['#text']));
        continue;
      }
      if ('#cdata' in child) {
        content.push(extractCdata(child['#cdata']));
        continue;
      }
      if (isElementNode(child)) {
        content.push(buildElement(child, namespaces, effectiveXmlSpace));
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
  qualifiedName: string,
  namespaces: ReadonlyMap<string, string>,
  defaultNamespaceApplies: boolean,
): { localName: string; namespaceUri: string | null } {
  const separator = qualifiedName.indexOf(':');
  if (separator < 0) {
    return {
      localName: qualifiedName,
      namespaceUri: defaultNamespaceApplies
        ? (namespaces.get('') ?? null)
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

function extractCdata(value: unknown): string {
  if (!Array.isArray(value)) return xmlScalarString(value);
  return value
    .filter(isRecord)
    .map((entry) => xmlScalarString(entry['#text']))
    .join('');
}

function xmlScalarString(value: unknown): string {
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

function isElementNode(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).some(
      (key) => key !== ':@' && !key.startsWith('#') && !key.startsWith('?'),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
