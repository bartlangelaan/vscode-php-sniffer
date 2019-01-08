import {
  CancellationTokenSource,
  ConfigurationChangeEvent,
  Diagnostic,
  DiagnosticCollection,
  DiagnosticSeverity,
  Disposable,
  languages,
  Range,
  TextDocument,
  TextDocumentChangeEvent,
  Uri,
  window,
  workspace,
} from 'vscode';
import childProcess = require('child_process');
import { join } from 'path';
import { PHPCSReport, PHPCSMessageType } from './phpcs-report';
import { debounce } from 'lodash';

/**
 * Kill process tree function from VSCode Go.
 * 
 * @param execProcess
 *   The process to kill.
 */
function killTree(execProcess: childProcess.ChildProcess): void {
  if (process.platform === 'win32') {
    const TASK_KILL = 'C:\\Windows\\System32\\taskkill.exe';

    // when killing a process in Windows its child processes are *not* killed
    // but become root processes. Therefore we use TASKKILL.EXE
    try {
      childProcess.execSync(`${TASK_KILL} /F /T /PID ${execProcess.pid}`);
    } catch (err) {
    }
  } else {
    // on linux and OS X we kill all direct and indirect child processes as well
    try {
      const cmd = join(__dirname, '../scripts/terminateProcess.sh');
      childProcess.spawnSync(cmd, [execProcess.pid.toString()]);
    } catch (err) {
    }
  }
}

const enum runConfig {
  save = 'onSave',
  type = 'onType',
}

export class Validator {
  private diagnosticCollection: DiagnosticCollection = languages.createDiagnosticCollection('php');

  /**
   * The active validator listener.
   */
  private validatorListener?: Disposable;

  /**
   * Token to cancel a current validation runs.
   */
  private runnerCancellations: Map<Uri, CancellationTokenSource> = new Map();

  constructor(subscriptions: Disposable[]) {
    workspace.onDidChangeConfiguration(this.onConfigChange, this, subscriptions);
    workspace.onDidOpenTextDocument(this.validate, this, subscriptions);
    workspace.onDidCloseTextDocument(this.clearDocumentDiagnostics, this, subscriptions);
    workspace.onDidChangeWorkspaceFolders(this.refresh, this, subscriptions);
    
    this.refresh();
    this.setValidatorListener();
  }

  /**
   * Dispose this object.
   */
  public dispose(): void {
    this.diagnosticCollection.clear();
    this.diagnosticCollection.dispose();
  }

  /**
   * Reacts on configuration change.
   * 
   * @param event - The configuration change event.
   */
  protected onConfigChange(event: ConfigurationChangeEvent): void {
    if (!event.affectsConfiguration('phpSniffer')) {
      return;
    }
    
    if (event.affectsConfiguration('phpSniffer.run') || event.affectsConfiguration('phpSniffer.onTypeDelay')) {
      this.setValidatorListener();
    }

    this.refresh();
  }

  /**
   * Sets the validation event listening.
   */
  protected setValidatorListener(): void {
    if (this.validatorListener) {
      this.validatorListener.dispose();
    }

    const config = workspace.getConfiguration('phpSniffer');
    const run: runConfig = config.get('run', runConfig.save);
    const delay: number = config.get('onTypeDelay', 250);

    if (run === runConfig.type as string) {
      const validator = debounce(
        ({ document }: TextDocumentChangeEvent): void => { this.validate(document); },
        delay,
      );
      this.validatorListener = workspace.onDidChangeTextDocument(validator);
    }
    else {
      this.validatorListener = workspace.onDidSaveTextDocument(this.validate, this);
    }
  }

  /**
   * Refreshes validation on any open documents.
   */
  protected refresh(): void {
    this.diagnosticCollection!.clear();

    workspace.textDocuments.forEach(this.validate, this);
  }

  /**
   * Lints a document.
   * 
   * @param document - The document to lint.
   */
  protected validate(document: TextDocument): void {
    if (document.languageId !== 'php') {
      return;
    }

    const oldRunner = this.runnerCancellations.get(document.uri);
    if (oldRunner) {
      oldRunner.cancel();
      oldRunner.dispose();
    }

    const runner = new CancellationTokenSource();
    this.runnerCancellations.set(document.uri, runner);
    const { token } = runner;

    const config = workspace.getConfiguration('phpSniffer', document.uri);
    const execFolder: string = config.get('executablesFolder', '');
    const standard: string = config.get('standard', '');

    const args = [
      '--report=json',
      `--standard="${standard}"`,
      '-'
    ];

    const spawnOptions = {
      cwd: workspace.workspaceFolders && workspace.workspaceFolders[0].uri.scheme === 'file'
        ? workspace.workspaceFolders[0].uri.fsPath
        : undefined,
      timeout: 2000
    };
    const executable = `phpcs${process.platform === 'win32' ? '.bat' : ''}`;
    const command = childProcess.exec(`${execFolder}${executable} ${args.join(' ')}`, spawnOptions);

    token.onCancellationRequested(() => killTree(command));

    let stdout = '';
    let stderr = '';

    command.stdin.write(document.getText());
    command.stdin.end();

    command.stdout.setEncoding('utf8');
    command.stdout.on('data', data => stdout += data);
    command.stderr.on('data', data => stderr += data);

    command.on('exit', () => command.stdin.destroy());

    const done = new Promise((resolve, reject) => {
      command.on('close', code => {
        if (token.isCancellationRequested) {
          console.warn('Validation cancelled.');
          resolve();
        }
        else {
          const diagnostics: Diagnostic[] = [];
           
          try {
            const { files: { STDIN: report } }: PHPCSReport = JSON.parse(stdout);
            report.messages.forEach(({ message, line, column, type, source }) => {
              const zeroLine = line - 1;
              const ZeroColumn = column - 1;

              diagnostics.push(
                new Diagnostic(
                  new Range(zeroLine, ZeroColumn, zeroLine, ZeroColumn),
                  `[${source}]\n${message}`,
                  type === PHPCSMessageType.ERROR ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
                ),
              );
            });
            resolve();
          } catch(error) {
            console.error(stdout);
            console.error(stderr);
            console.error(error.toString());
            reject();
          }

          this.diagnosticCollection.set(document.uri, diagnostics);
        }

        runner.dispose();
        this.runnerCancellations.delete(document.uri);
      });
    });

    window.setStatusBarMessage('PHP Sniffer: validating…', done);
  }

  /**
   * Clears diagnostics from a document.
   * 
   * @param document - The document to clear diagnostics of.
   */
  protected clearDocumentDiagnostics({ uri }: TextDocument): void {
    this.diagnosticCollection.delete(uri);
  }

}