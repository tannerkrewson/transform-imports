const path = require("path");
const fs = require("fs");
const { createMacro, MacroError } = require("babel-plugin-macros");
const t = require("babel-types");
const generate = require("babel-generator").default;
const TextBuffer = require("text-buffer");
const md5 = require("md5");

module.exports = createMacro(runOnServerMacro, { configName: "runOnServer" });

function getSourceForNode(node, state) {
  const { start, end } = node.loc;
  const range = new TextBuffer.Range(
    [start.line - 1, start.column],
    [end.line - 1, end.column]
  );
  const source = state.file.code;
  return new TextBuffer(source).getTextInRange(range);
}

function runOnServerMacro({ references, state, babel, config }) {
  const outputPath =
    config.outputPath ||
    path.join(process.cwd(), "run-on-server-id-mappings.js");

  const outputContent = t.expressionStatement(
    t.assignmentExpression(
      "=",
      t.memberExpression(t.identifier("module"), t.identifier("exports")),
      t.objectExpression([])
    )
  );

  const addMapping = (id, expressionNode) => {
    const newProperty = t.objectProperty(t.stringLiteral(id), expressionNode);
    outputContent.expression.right.properties.push(newProperty);
  };

  const referenceNames = {};

  // Note: `references` are references to createClient, not runOnServer. We need
  // to find references to runOnServer.
  references.default.forEach((createClientReference) => {
    if (createClientReference.isIdentifier()) {
      referenceNames[createClientReference.node.name] = true;
    }

    const declarator = createClientReference.findParent((path) =>
      path.isVariableDeclarator()
    );

    if (declarator == null) {
      throw new MacroError(
        "Found a situation where the result of calling createClient was not " +
          "saved to a variable. Saving the result of createClient to a " +
          "variable is the only suported way to use the run-on-server macro. " +
          "For example:\n" +
          `  const runOnServer = createClient("http://somewhere:3000")\n`
      );
    }

    const id = declarator.get("id");
    if (!id.isIdentifier()) {
      throw new MacroError(
        "Found a situation where the result of calling createClient was " +
          "saved to a variable, but that variable was created in an unexpected " +
          "way. The only variable declaration forms supported by the " +
          "run-on-server macro are:\n" +
          `  const runOnServer = createClient("http://somewhere:3000");\nOR\n` +
          `  var runOnServer = createClient("http://somewhere:3000");\nOR\n` +
          `  let runOnServer = createClient("http://somewhere:3000");\n`
      );
    }

    const bindings = id.scope.bindings[id.node.name];
    if (bindings == null) {
      // They made a runOnServer function but aren't using it anywhere yet.
      return;
    }

    const runOnServerPaths = bindings.referencePaths;
    runOnServerPaths.forEach((referencePath) => {
      if (!referencePath.parentPath.isCallExpression()) {
        throw new MacroError(
          "The runOnServer function returned by createClient was referenced " +
            "in a way where it wasn't a direct variable call. For instance, " +
            "you might be putting runOnServer in an object literal, or " +
            "trying to use runOnServer.call or runOnServer.apply. This is " +
            "not supported- the only form of referencing runOnServer " +
            "supported by the run-on-server macro is calling it directly, eg " +
            "runOnServer(...)."
        );
      }

      const callExpression = referencePath.parentPath;
      let code = callExpression.get("arguments")[0];
      if (code == null) {
        throw new MacroError(
          "The runOnServer function returned by createClient was called " +
            "without any arguments. This is not a valid use of the library."
        );
      }

      if (code.isTemplateLiteral()) {
        if (code.node.expressions.length > 0) {
          throw new MacroError(
            "Found a template literal with embedded expressions being passed " +
              "to runOnServer. This is not supported. Instead of doing this, " +
              "use the `args` argument within the template literal string to " +
              "reference the optional array that can be passed as the second " +
              "argument to runOnServer."
          );
        }
      }

      if (
        !(
          code.isTemplateLiteral() ||
          code.isStringLiteral() ||
          code.isArrowFunctionExpression() ||
          code.isFunctionExpression()
        )
      ) {
        // TODO: If it's an identifier and that identifier refers to a function
        // declared in the same file, handle it properly.
        throw new MacroError(
          "Found a situation where runOnServer was called and the first " +
            "argument was not a template literal, string literal, arrow " +
            "function expression, or function expression. These are the only " +
            "forms supported by the run-on-server macro."
        );
      }

      const source = getSourceForNode(code.node, state);
      const codeId = md5(source);
      addMapping(codeId, JSON.parse(JSON.stringify(code.node)));
      code.replaceWith(
        t.objectExpression([
          t.objectProperty(t.identifier("id"), t.stringLiteral(codeId)),
        ])
      );
    });
  });

  if (references.default.length > 0 && Object.keys(referenceNames).length > 0) {
    const program = references.default[0].findParent((parentPath) =>
      parentPath.isProgram()
    );
    if (program != null) {
      Object.keys(referenceNames).forEach((referenceName) => {
        const newImport = t.variableDeclaration("var", [
          t.variableDeclarator(
            t.identifier(referenceName),
            t.callExpression(t.identifier("require"), [
              t.stringLiteral("run-on-server/client"),
            ])
          ),
        ]);
        program.unshiftContainer("body", newImport);
      });
    }
  }

  const comment = [
    `\nThis file was generated by the run-on-server babel macro. It should not`,
    `be edited by hand.`,
    ``,
    `If you want to output this file to a different location, you can`,
    `configure the macro by creating a file named \`babel-plugin-macros.config.js\``,
    `in the root of your project with the following content:`,
    ``,
    `const path = require("path");`,
    `module.exports = {`,
    `  runOnServer: {`,
    `    outputPath: path.resolve(__dirname, "somewhere", "else.js")`,
    `  }`,
    `};\n`,
  ].join("\n");

  const output = generate(t.program([outputContent]), {
    auxiliaryCommentBefore: comment,
    filename: __filename,
  });
  fs.writeFileSync(outputPath, output.code);
}
