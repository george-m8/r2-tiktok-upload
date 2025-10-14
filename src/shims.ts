// src/shims.ts
import { DOMParser as XmldomParser, XMLSerializer as XmldomSerializer } from "@xmldom/xmldom";

// Provide DOMParser / XMLSerializer if missing (Workers / bundlers may not define them)
if (typeof (globalThis as any).DOMParser === "undefined") {
  (globalThis as any).DOMParser = XmldomParser as any;
}
if (typeof (globalThis as any).XMLSerializer === "undefined") {
  (globalThis as any).XMLSerializer = XmldomSerializer as any;
}