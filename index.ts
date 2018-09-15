import * as findUp from 'find-up';
import * as Oni from 'oni-api';
import * as path from 'path';
import { IRuleFailureJson } from 'tslint';
import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver-types';

const tslintPath = path.join(__dirname, '..', 'node_modules', '.bin', 'tslint');

let lastErrors: any = {};

interface FileDiagnostic extends Diagnostic {
    file: string;
}

interface DiagnosticsByFile {
    [filename: string]: Diagnostic[];
}

const activate = (oni: Oni.Plugin.Api): void => {

    const doLintForFile = async (event: Oni.EditorBufferEventArgs | null, autoFix: boolean) => {
        if (event && event.language !== 'typescript') {
            return;
        }

        const filePath = (event && event.filePath) ? event.filePath : oni.editors.activeEditor.activeBuffer.filePath;
        const currentWorkingDirectory = getCurrentWorkingDirectory(filePath);
        const lintConfig = await getLintConfig(currentWorkingDirectory);

        if (!lintConfig) {
            throw new Error('No tslint.json found; not running tslint.');
        }

        const errors: DiagnosticsByFile = await executeTsLint(lintConfig, [filePath], currentWorkingDirectory, autoFix);

        // When running for a single file, only the filename will be included in the results
        const fileName: string = path.basename(filePath);
        const fileErrors: Diagnostic[] = errors[fileName] || [];

        oni.diagnostics.setErrors(filePath, 'tslint-ts', fileErrors);

        if (!fileErrors || fileErrors.length === 0) {
            lastErrors[filePath] = null;
        }
    };

    const doLintForProject = async (event: Oni.EditorBufferEventArgs, autoFix: boolean) => {
        if (!event.filePath) {
            return;
        }

        const currentWorkingDirectory: string = getCurrentWorkingDirectory(event.filePath);
        const lintConfig = await getLintConfig(currentWorkingDirectory);
        if (!lintConfig) {
            throw new Error('No tslint.json found; not running tslint.');
        }
        const project = await getTsConfig(currentWorkingDirectory);
        const processArgs = [];
        if (project) {
            processArgs.push('--project', project);
        } else {
            processArgs.push(event.filePath);
        }

        const errors: DiagnosticsByFile = await executeTsLint(lintConfig, processArgs, currentWorkingDirectory, autoFix);

        // Send all updated errors
        Object.keys(errors).forEach(filename => {
            oni.diagnostics.setErrors(filename, 'tslint-ts', errors[filename]);
        });

        // Send all errors that were cleared
        Object.keys(lastErrors).forEach(filename => {
            if (lastErrors[filename] && !errors[filename]) {
                oni.diagnostics.setErrors(filename, 'tslint-ts', []);
            }
        });

        lastErrors = errors;
    };

    oni.editors.activeEditor.onBufferEnter.subscribe((buf: Oni.EditorBufferEventArgs) => doLintForProject(buf, false));
    oni.editors.activeEditor.onBufferSaved.subscribe((buf: Oni.EditorBufferEventArgs) => doLintForFile(buf, false));

    oni.commands.registerCommand({
        command: 'tslint.fix.file',
        name: 'TSLint Fix File',
        detail: 'Auto-fix TSLint errors in current buffer',
        execute: (_args?: any) => {
            doLintForFile(null, true);
        }
    });

    async function executeTsLint(configPath: string, paths: string[], workingDirectory: string, autoFix: boolean = false): Promise<DiagnosticsByFile> {
        const processArgs: string[] = [
            '--force',
            '--format', 'json',
            '--config', configPath,
            ...paths
        ];

        if (autoFix) {
            processArgs.push('--fix');
        }

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
                })).sort((a, b) => {
                    if (a.range.start.line > b.range.start.line) {
                        return 1;
                    } else if (a.range.start.line < b.range.start.line) {
                        return -1;
                    } else if (a.range.start.character > b.range.start.character) {
                        return 1;
                    } else if (a.range.start.character < b.range.start.character) {
                        return -1;
                    } else {
                        return 0;
                    }
                });

                const errors: DiagnosticsByFile = errorsWithFileName.reduce((prev: any, curr: any) => {
                    prev[curr.file] = prev[curr.file] || [];

                    prev[curr.file].push({
                        message: curr.message,
                        range: curr.range,
                        severity: curr.severity,
                        type: curr.type,
                    });

                    return prev;
                }, {});

                if (autoFix) {
                    oni.editors.activeEditor.neovim!.command('checktime').then(() => resolve(errors)).catch((e) => reject(e));
                } else {
                    resolve(errors);
                }
            });
        });
    }

    function getCurrentWorkingDirectory(filepath: string) {
        return path.dirname(filepath);
    }

    async function getTsConfig(workingDirectory: string) {
        return findUp('tsconfig.json', { cwd: workingDirectory });
    }

    async function getLintConfig(workingDirectory: string) {
        return findUp('tslint.json', { cwd: workingDirectory });
    }
};

module.exports = {
    activate
};
