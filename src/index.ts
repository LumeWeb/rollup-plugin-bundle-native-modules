import astMatcher from "ast-matcher";
import MagicString from "magic-string";
// @ts-ignore
import loady from "loady";
import fs from "fs";
import type { PluginContext } from "rollup";
import type { Plugin } from "vite";

const loaderFunction = `function loadNativeModuleTemp(module, data) {
  const tempDir = require("os").tmpdir();
  const fs = require("fs");
  const path = require("path");
  const outputPath = path.join(tempDir, module, "build", "Release");
  const modulePath = path.join(outputPath, module + ".node");

  fs.mkdirSync(outputPath, { recursive: true });
  fs.writeFileSync(modulePath, Buffer.from(data, "base64"));

  return modulePath;
}`;

type Edit = [number, number];
type AstNode = { start: number; end: number };

export default function bundleNativeModulesPlugin() {
  const edits: Edit[] = [];

  /*
  Copied from https://github.com/sastan/rollup-plugin-define/blob/main/src/define.ts
   */
  function markEdited(node: AstNode, edits: Edit[]): number | false {
    for (const [start, end] of edits) {
      if (
        (start <= node.start && node.start < end) ||
        (start < node.end && node.end <= end)
      ) {
        return false; // Already edited
      }
    }

    // Not edited
    return edits.push([node.start, node.end]);
  }

  return {
    name: "bundle-native-modules",
    transform(src, id, ast: any) {
      if (!/\.(js)$/.test(id)) {
        return null;
      }
      if (!/binding/.test(src)) {
        return null;
      }

      const magicString = new MagicString(src);

      const parse = (
        code: string,
        source = code
      ): ReturnType<PluginContext["parse"]> => {
        try {
          return this.parse(code, undefined);
        } catch (error) {
          (error as Error).message += ` in ${source}`;
          throw error;
        }
      };

      astMatcher.setParser(parse);

      if (!ast) {
        try {
          ast = parse(src);
        } catch (e) {
          throw e;
        }
      }

      const findLoady = astMatcher("require('loady')(__str_aName, __any)");
      const loadyMatches = findLoady(ast);

      if (loadyMatches?.length) {
        for (const match of loadyMatches) {
          if (markEdited(match.node, edits)) {
            const modulePath = loady.resolve(match.match.aName, id);
            const moduleFile = fs.readFileSync(modulePath);
            const moduleB64 = moduleFile.toString("base64");
            magicString.overwrite(
              match.node.start,
              match.node.end,
              `require('loady')('${match.match.aName}', loadNativeModuleTemp('${match.match.aName}', '${moduleB64}'))`
            );
          }
        }
      }

      if (edits.length === 0) {
        return null;
      }

      const findStrict = astMatcher('"use strict";');
      const strictMatches = findStrict(ast);

      let injectNode;

      if (strictMatches?.length) {
        injectNode = strictMatches[0].node;
      } else {
        injectNode = ast.body[0];
      }

      magicString.appendRight(injectNode.end + 1, loaderFunction);

      return {
        code: magicString.toString(),
        map: magicString.generateMap({
          source: src,
          includeContent: true,
          hires: true,
        }),
      };
    },
  } as Plugin;
}
