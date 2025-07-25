import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { parse } from "node-html-parser";

export async function bindgen(config) {
  await fs.mkdir(config.outputDir, { recursive: true });

  const inputDir = path.resolve(config.inputDir);
  const inputFilePaths = await fs
    .readdir(config.inputDir, { recursive: true })
    .then((x) => x.map((y) => path.parse(path.join(inputDir, y))));
  const inputHtmlPaths = inputFilePaths.filter((x) => x.ext === ".html");
  const inputCssPaths = inputFilePaths.filter((x) => x.ext === ".css");

  const ensured = new Set();
  const keep = [];
  const queue = inputHtmlPaths.slice();
  const nproc = os.cpus().length;
  while (queue.length) {
    const chunk = queue.splice(-1, nproc);
    await Promise.all(
      chunk.map(async (inputFilePath) => {
        const inputFileName = path.join(
          inputFilePath.dir.replace(inputDir, ""),
          inputFilePath.name,
        );
        const outputFilePath = path.join(
          config.outputDir,
          inputFileName + ".ts",
        );
        const cssOutputFilePath = path.join(
          config.outputDir,
          inputFileName + ".css",
        );
        const cssTsOutputFilePath = path.join(
          config.outputDir,
          inputFileName + ".css.ts",
        );

        keep.push(outputFilePath, cssOutputFilePath, cssTsOutputFilePath);

        const existingBuf = await fs
          .readFile(outputFilePath)
          .then((x) => x.toString())
          .catch(() => {});
        const inputFileStats = await fs.stat(path.format(inputFilePath));
        const mtime = inputFileStats.mtime.toISOString();
        if (existingBuf && mtime === parseMtime(existingBuf)) {
          return;
        }

        const ensureDir = path.dirname(outputFilePath);
        if (!ensured.has(ensureDir)) {
          ensured.add(ensureDir);
          await fs.mkdir(ensureDir, { recursive: true });
        }

        const htmlBuf = await fs
          .readFile(path.format(inputFilePath))
          .then((x) => x.toString());

        let ts, css;
        if (/^<!DOCTYPE/i.test(htmlBuf)) {
          ts = parseIds(htmlBuf);
          const cssPath = inputCssPaths.find((x) => {
            return x.dir === inputFilePath.dir && x.name === inputFilePath.name;
          });
          if (cssPath) {
            css = await fs
              .readFile(path.format(cssPath))
              .then((x) => x.toString());
            const cssTs = parseCSS(css);
            if (cssTs) {
              await fs.writeFile(cssTsOutputFilePath, cssTs);
              ts =
                `export * as css from "./${path.basename(cssTsOutputFilePath)}";\n` +
                ts;
            }
          }
        } else {
          const parsed = parseHTML(htmlBuf, mtime);
          ts = parsed.ts;
          css = parsed.css;
        }

        await fs.writeFile(outputFilePath, ts);
        if (css) {
          await fs.writeFile(cssOutputFilePath, css);
        }
      }),
    );
  }

  await removeOld(config.outputDir, keep);
}

function parseMtime(buf) {
  const start = buf.indexOf(" ");
  const end = buf.indexOf("\n");
  return buf.slice(start + 1, end);
}

function parseIds(s) {
  const lines = [];
  const needle = 'id="';
  let offset = 0;
  while (true) {
    const start = s.indexOf(needle, offset);
    if (start === -1) break;
    const end = s.indexOf('"', start + needle.length);
    const name = s.slice(start + needle.length, end);
    const tagStart = s.slice(0, end).lastIndexOf("<");
    const tagEnd = s.slice(tagStart).search(/\s/) + tagStart;
    const tag = s.slice(tagStart + 1, tagEnd);
    const as = parseHTMLType(tag.toUpperCase());
    lines.push(
      `export const ${name} = document.getElementById("${name}") as ${as};`,
    );
    offset = end;
  }
  return lines.join("\n");
}

function parseCSS(s) {
  const classes = new Set();
  let offset = s.length;
  while (true) {
    const openBraketPos = s.slice(0, offset).lastIndexOf("{");
    if (openBraketPos === -1) break; // 0 means we are at the first rule.
    let selStartPos = s.slice(0, openBraketPos).lastIndexOf("}");
    if (selStartPos === -1) {
      selStartPos = 0;
    } else {
      selStartPos += 1;
    }
    let selOffset = openBraketPos;
    while (true) {
      const dotPos = s.slice(selStartPos, selOffset).lastIndexOf(".");
      if (dotPos === -1) break;
      let classStartPos = selStartPos + dotPos + 1;
      let selLen;
      for (const [index, c] of Array.from(s.slice(classStartPos)).entries()) {
        if (!/^[a-z0-9]+$/i.test(c) && c !== "-" && c !== "_") {
          selLen = index;
          break;
        }
      }
      let classEndPos = classStartPos + selLen;
      let classIdent = s.slice(classStartPos, classEndPos);

      selOffset = selStartPos + dotPos; // Skip media queries with a decimal.

      if (classIdent.endsWith("px") && !isNaN(parseInt(classIdent))) {
        continue;
      }

      classes.add(classIdent);
    }
    offset = selStartPos;
  }

  const lines = [];
  for (const ident of classes) {
    lines.push(`export const ${toCamel(ident)} = "${ident}";`);
  }
  return lines.join("\n");
}

function parseHTML(html, mtime) {
  const ts = [];
  const css = [];
  const root = parse(html);
  for (const child of root.childNodes) {
    if (!child.getAttribute) continue;
    if (child.tagName === "STYLE") {
      css.push(child.innerHTML);
      ts.push(writeCSS(child.innerHTML));
    } else {
      const parsed = parseTemplate(child);
      ts.push(writeTemplate(parsed));
    }
  }
  return {
    ts: `// ${mtime}\n` + ts.join("\n\n"),
    css: css.join(""),
  };
}

function parseTemplate(node) {
  const name = node.getAttribute("id");
  const idAttr = node.getAttribute("id_");
  if (idAttr) {
    node.removeAttribute("id_");
    node.setAttribute("id", idAttr);
  } else {
    node.removeAttribute("id");
  }
  const type = parseHTMLType(node.tagName);
  const refs = parseRefs(node);
  node.removeWhitespace();
  return {
    name,
    type,
    refs,
    html: node.outerHTML,
  };
}

function parseRefs(node, path = [], acc = []) {
  const ref = node.getAttribute("id");
  if (ref) {
    node.removeAttribute("id");
    acc.push({
      name: ref,
      type: parseHTMLType(node.tagName),
      path: "this.base" + path.map((x) => `.children[${x}]!`).join(""),
    });
  }
  const idAttr = node.getAttribute("id_");
  if (idAttr) {
    node.removeAttribute("id_");
    node.setAttribute("id", idAttr);
  }
  let index = 0;
  for (const child of node.childNodes) {
    if (!child.getAttribute) continue;
    path.push(index);
    parseRefs(child, path, acc);
    path.pop();
    index += 1;
  }
  return acc;
}

function parseHTMLType(tagName) {
  switch (tagName) {
    case "INPUT":
      return "HTMLInputElement";
    case "SELECT":
      return "HTMLSelectElement";
    case "FORM":
      return "HTMLFormElement";
    case "TEXTAREA":
      return "HTMLTextAreaElement";
    case "CANVAS":
      return "HTMLCanvasElement";
    case "AUDIO":
      return "HTMLAudioElement";
    case "BUTTON":
      return "HTMLButtonElement";
    case "A":
      return "HTMLAnchorElement";
    case "DIALOG":
      return "HTMLDialogElement";
    default:
      return "HTMLElement";
  }
}

function writeTemplate({ name, type, refs, html }) {
  const fieldTypes = [];
  const fieldInits = [];
  for (const ref of refs) {
    fieldTypes.push(`${ref.name}: ${ref.type};`);
    fieldInits.push(`this.${ref.name} = ${ref.path} as ${ref.type};`);
  }

  return `
let _${name}: HTMLElement | undefined;
export class ${name} {
  base: ${type};
  ${fieldTypes.join("\n  ")}

  constructor() {
    if (!_${name}) {
      const tmp = document.createElement("div");
      tmp.innerHTML = \`${html}\`;
      _${name} = tmp.children[0]! as HTMLElement;
    }
    this.base = _${name}!.cloneNode(true) as ${type};
    ${fieldInits.join("\n    ")}
  }
}
  `.trim();
}

function writeCSS(s) {
  const classes = new Set();
  let offset = s.length;
  while (true) {
    const openBraketPos = s.slice(0, offset).lastIndexOf("{");
    if (openBraketPos === -1) break; // 0 means we are at the first rule.
    let selStartPos = s.slice(0, openBraketPos).lastIndexOf("}");
    if (selStartPos === -1) {
      selStartPos = 0;
    } else {
      selStartPos += 1;
    }
    let selOffset = openBraketPos;
    while (true) {
      const dotPos = s.slice(selStartPos, selOffset).lastIndexOf(".");
      if (dotPos === -1) break;
      let classStartPos = selStartPos + dotPos + 1;
      let selLen;
      for (const [index, c] of Array.from(s.slice(classStartPos)).entries()) {
        if (!/^[a-z0-9]+$/i.test(c) && c !== "-" && c !== "_") {
          selLen = index;
          break;
        }
      }
      let classEndPos = classStartPos + selLen;
      let classIdent = s.slice(classStartPos, classEndPos);

      selOffset = selStartPos + dotPos; // Skip media queries with a decimal.

      if (classIdent.endsWith("px") && !isNaN(parseInt(classIdent))) {
        continue;
      }

      classes.add(classIdent);
    }
    offset = selStartPos;
  }

  const lines = [];
  for (const ident of classes) {
    lines.push(`export const ${toCamel(ident)} = "${ident}";`);
  }
  return lines.join("\n");
}

function toCamel(s) {
  return s
    .split("-")
    .map((c, index) => {
      if (index == 0) {
        return c.toLowerCase();
      }
      return c[0].toUpperCase() + c.slice(1).toLowerCase();
    })
    .join("");
}

async function removeOld(dirPath, keep) {
  const ents = await fs.readdir(dirPath, { withFileTypes: true });
  for (const ent of ents) {
    const entPath = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      await removeOld(entPath, keep);
    } else if (!keep.includes(entPath)) {
      await fs.rm(entPath);
    }
  }

  const isEmpty = (await fs.readdir(dirPath)).length === 0;
  if (isEmpty) await fs.rm(dirPath, { force: true, recursive: true });
}
