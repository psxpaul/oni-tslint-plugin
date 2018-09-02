import * as findUp from 'find-up';
import * as Oni from 'oni-api'
import * as path from 'path';
import { IRuleFailureJson } from 'tslint';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';

const tslintPath = path.join(__dirname, '..', 'node_modules', '.bin', 'tslint')

let lastErrors: any = {};
let lastEvent: Oni.EditorBufferEventArgs|null = null;

interface FileDiagnostic extends Diagnostic {
    file: string;
}

interface DiagnosticsByFile {
    [filename: string]: Diagnostic[];
}

const activate = (oni: Oni.Plugin.Api): void => {

    const doLintForFile = async (event: Oni.EditorBufferEventArgs) => {
        if (!event.filePath || event.language !== 'typescript') {
            return
        }

        const currentWorkingDirectory = getCurrentWorkingDirectory(event.filePath)
        const filePath = await getLintConfig(currentWorkingDirectory)

        if (!filePath) {
            throw new Error('No tslint.json found; not running tslint.')
        }

        const errors: DiagnosticsByFile = await executeTsLint(filePath, [event.filePath], currentWorkingDirectory)

        // When running for a single file, only the filename will be included in the results
        const fileName: string = path.basename(event.filePath)
        const fileErrors: Diagnostic[] = errors[fileName] || []

        oni.diagnostics.setErrors(event.filePath, 'tslint-ts', fileErrors)

        if (!fileErrors || fileErrors.length === 0) {
            lastErrors[event.filePath] = null
        }
    }

    const doLintForProject = async (event: Oni.EditorBufferEventArgs|null, autoFix: boolean) => {
        if (!event || !event.filePath) {
            return
        }

        lastEvent = event

        const currentWorkingDirectory: string = getCurrentWorkingDirectory(event.filePath)
        const filePath = await getLintConfig(currentWorkingDirectory)
        if (!filePath) {
            throw new Error('No tslint.json found; not running tslint.')
        }
        const project = await getTsConfig(currentWorkingDirectory)
        const processArgs = []
        if (project) {
            processArgs.push('--project', project)
        } else {
            processArgs.push(event.filePath)
        }

        const errors: DiagnosticsByFile = await executeTsLint(filePath, processArgs, currentWorkingDirectory, autoFix)

        // Send all updated errors
        Object.keys(errors).forEach(filename => {
            oni.diagnostics.setErrors(filename, 'tslint-ts', errors[filename]);
        })

        // Send all errors that were cleared
        Object.keys(lastErrors).forEach(filename => {
            if (lastErrors[filename] && !errors[filename]) {
                oni.diagnostics.setErrors(filename, 'tslint-ts', []);
            }
        })

        lastErrors = errors
    }

    oni.editors.activeEditor.onBufferEnter.subscribe((buf: Oni.EditorBufferEventArgs) => doLintForProject(buf, false))
    oni.editors.activeEditor.onBufferSaved.subscribe((buf: Oni.EditorBufferEventArgs) => doLintForFile(buf))

    oni.commands.registerCommand({
        command: 'tslint.fix',
        name: 'TSLint Fix',
        detail: 'Auto-fix TSLint errors',
        execute: (_args?: any) => {
            doLintForProject(lastEvent, true)
        }
    });

    async function executeTsLint(configPath: string, paths: string[], workingDirectory: string, autoFix: boolean = false): Promise<DiagnosticsByFile> {
        const processArgs: string[] = [];

        if (autoFix) {
            processArgs.push('--fix');
        }

        processArgs.push('--force', '--format', 'json');
        processArgs.push('--config', configPath);
        processArgs.push(...paths);

        return new Promise<DiagnosticsByFile>((resolve, reject) => {
            oni.process.execNodeScript(tslintPath, processArgs, { cwd: workingDirectory }, (err, stdout, _stderr) => {
                if (err) {
                    console.error(err);
                    reject(err);
                }

                const errorOutput: string = stdout.trim();
                const lintErrors: IRuleFailureJson[] = JSON.parse(errorOutput);

                const errorsWithFileName: FileDiagnostic[] = lintErrors.map((error: IRuleFailureJson) => ({
                    file: path.normalize(error.name),
                    message: `[${error.ruleName}] ${error.failure}`,
                    severity: DiagnosticSeverity.Warning,
                    range: {
                        start: {
                            line: error.startPosition.line,
                            character: error.startPosition.character,
                        },
                        end: {
                            line: error.endPosition.line,
                            character: error.endPosition.character
                        }
                    }
                }));

                const errors: DiagnosticsByFile = errorsWithFileName.reduce((prev: any, curr: any) => {
                    prev[curr.file] = prev[curr.file] || []

                    prev[curr.file].push({
                        message: curr.message,
                        range: curr.range,
                        severity: curr.severity,
                        type: curr.type,
                    })

                    return prev
                }, {});

                resolve(errors);
            })
        });
    }

    function getCurrentWorkingDirectory(filepath: string) {
        return path.dirname(filepath);
    }

    async function getTsConfig(workingDirectory: string) {
        return findUp('tsconfig.json', { cwd: workingDirectory })
    }

    async function getLintConfig(workingDirectory: string) {
        return findUp('tslint.json', { cwd: workingDirectory })
    }
}

module.exports = {
    activate
}
