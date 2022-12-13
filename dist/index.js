"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ast_matcher_1 = __importDefault(require("ast-matcher"));
const magic_string_1 = __importDefault(require("magic-string"));
// @ts-ignore
const loady_1 = __importDefault(require("loady"));
const fs_1 = __importDefault(require("fs"));
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
function bundleNativeModulesPlugin() {
    const edits = [];
    /*
    Copied from https://github.com/sastan/rollup-plugin-define/blob/main/src/define.ts
     */
    function markEdited(node, edits) {
        for (const [start, end] of edits) {
            if ((start <= node.start && node.start < end) ||
                (start < node.end && node.end <= end)) {
                return false; // Already edited
            }
        }
        // Not edited
        return edits.push([node.start, node.end]);
    }
    return {
        name: "bundle-native-modules",
        transform(src, id, ast) {
            if (!/\.(js)$/.test(id)) {
                return null;
            }
            if (!/binding/.test(src)) {
                return null;
            }
            const magicString = new magic_string_1.default(src);
            const parse = (code, source = code) => {
                try {
                    return this.parse(code, undefined);
                }
                catch (error) {
                    error.message += ` in ${source}`;
                    throw error;
                }
            };
            ast_matcher_1.default.setParser(parse);
            if (!ast) {
                try {
                    ast = parse(src);
                }
                catch (e) {
                    throw e;
                }
            }
            const findLoady = (0, ast_matcher_1.default)("require('loady')(__str_aName, __any)");
            const loadyMatches = findLoady(ast);
            if (loadyMatches?.length) {
                for (const match of loadyMatches) {
                    if (markEdited(match.node, edits)) {
                        const modulePath = loady_1.default.resolve(match.match.aName, id);
                        const moduleFile = fs_1.default.readFileSync(modulePath);
                        const moduleB64 = moduleFile.toString("base64");
                        magicString.overwrite(match.node.start, match.node.end, `require('loady')('${match.match.aName}', loadNativeModuleTemp('${match.match.aName}', '${moduleB64}'))`);
                    }
                }
            }
            if (edits.length === 0) {
                return null;
            }
            const findStrict = (0, ast_matcher_1.default)('"use strict";');
            const strictMatches = findStrict(ast);
            let injectNode;
            if (strictMatches?.length) {
                injectNode = strictMatches[0].node;
            }
            else {
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
    };
}
exports.default = bundleNativeModulesPlugin;
//# sourceMappingURL=index.js.map