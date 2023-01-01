import astMatcher from "ast-matcher";
import MagicString from "magic-string";
// @ts-ignore
import loady from "loady";
// @ts-ignore
import nodeGybBuild from "node-gyp-build";
// @ts-ignore
import nodeGybBuildOptional from "node-gyp-build-optional-packages";
import fs from "fs";
import type { PluginContext } from "rollup";
import type { Plugin } from "vite";
import path from "path";

const loaderFunction = `
function loadNativeModuleTemp (module, data) {
  const loady = require("loady");
  const tempDir = require("os").tmpdir();
  const fs = require("fs");
  const path = require("path");
  const loadPath = path.join(tempDir, module);
  const outputPath = path.join(loadPath, "build", "Release");
  const modulePath = path.join(outputPath, module + ".node");

  fs.mkdirSync(outputPath, { recursive: true });
  fs.writeFileSync(modulePath, Buffer.from(data, "base64"));

  if (process.pkg) {
    process.pkg = undefined;
  }
  
 return loady(module, loadPath);
}`;

type Edit = [number, number];
type AstNode = { start: number; end: number };

export default function bundleNativeModulesPlugin() {
  return {
    name: "bundle-native-modules",
    transform(src, id, ast: any) {
      if (!/\.(c?js)$/.test(id)) {
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

      for (const matchString of ["require('loady')(__str_aName, __any)"]) {
        const findLoady = astMatcher(matchString);
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
                `loadNativeModuleTemp('${match.match.aName}', '${moduleB64}')`
              );
            }
          }
        }
      }

      for (const matchString of [
        "require('node-gyp-build')(__any)",
        "loadNAPI(__any)",
        "loadNAPI__default[__any](__any)",
      ]) {
        const findNodeBuildGyp = astMatcher(matchString);
        const nodeBuildGypMatches = findNodeBuildGyp(ast);

        if (nodeBuildGypMatches?.length) {
          for (const match of nodeBuildGypMatches) {
            if (markEdited(match.node, edits)) {
              let modulePath;

              try {
                modulePath = nodeGybBuild.path(path.dirname(id));
              } catch {}

              if (!modulePath) {
                try {
                  modulePath = nodeGybBuildOptional.path(path.dirname(id));
                } catch {}
                let parentDir = path.dirname(id);
                do {
                  parentDir = path.dirname(parentDir);
                } while (
                  !fs.existsSync(path.join(parentDir, "package.json")) &&
                  parentDir !== "/"
                );

                try {
                  modulePath = nodeGybBuildOptional.path(parentDir);
                } catch {}
              }

              if (!modulePath) {
                throw new Error(`Could not process native module for ${id}`);
              }

              let moduleName = "";

              for (const part of modulePath
                .split("node_modules")
                .pop()
                .split("/")
                .slice(1)) {
                if (part.includes(".node")) {
                  continue;
                }
                if (part === "prebuilds") {
                  break;
                }

                moduleName += part;

                if (part.includes("@")) {
                  moduleName += "_";
                }
              }

              const moduleFile = fs.readFileSync(modulePath);
              const moduleB64 = moduleFile.toString("base64");
              magicString.overwrite(
                match.node.start,
                match.node.end,
                `loadNativeModuleTemp('${moduleName}', '${moduleB64}')`
              );
            }
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
export { bundleNativeModulesPlugin };
