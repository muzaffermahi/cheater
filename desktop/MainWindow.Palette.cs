using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;

namespace Kitten.Desktop;

/// <summary>
/// The command surface. Everything that is not the conversation itself — models, runtimes,
/// benchmarks, agents, workspace tools, exports — used to be a button on the left rail, twenty-two of
/// them stacked above the session list. That is the opposite of usable: the rail competed with the
/// work, and the two controls a user actually needs (a session list and a prompt) were the smallest
/// things on screen.
///
/// Those actions now live behind Ctrl+K in one searchable list with a single definition each. The
/// window keeps only what a running task needs.
/// </summary>
public partial class MainWindow
{
    private sealed record PaletteCommand(string Title, string Group, string Hint, Action Invoke)
    {
        // ListBox renders items by ToString().
        public override string ToString() => $"{Title}   ·   {Group}{(string.IsNullOrEmpty(Hint) ? "" : $"   —   {Hint}")}";
    }

    private List<PaletteCommand> _paletteCommands = new();
    private readonly List<PaletteCommand> _paletteVisible = new();

    private void BuildPalette()
    {
        // Handlers are reused verbatim: the palette is another way to reach the same action, never a
        // second implementation of it.
        void Run(Action<object?, RoutedEventArgs> handler) => handler(this, new RoutedEventArgs());

        _paletteCommands = new List<PaletteCommand>
        {
            new("New task", "Session", "start a fresh durable conversation", () => Run(NewTask)),
            new("Open project…", "Session", "choose the workspace Kitten works in", () => Run(OpenProject)),
            new("Resume interrupted run", "Session", "continue from the last durable state", () => Run(ResumeInterrupted)),
            new("Export conversation", "Session", "write this session to Markdown", () => Run(ExportConversation)),

            new("Review changes", "Workspace", "diff every pending edit", () => Run(OpenWorkspaceChanges)),
            new("Browse files", "Workspace", "indexed files, symbols and tests", () => Run(OpenWorkspaceExplorer)),
            new("Run suggested checks", "Workspace", "execute the allow-listed verification", () => Run(RunSuggestedChecks)),
            new("Undo last run", "Workspace", "roll back to the run's git snapshot", () => Run(UndoLastRun)),
            new("Redo last undo", "Workspace", "re-apply what undo removed", () => Run(RedoLastRun)),

            new("Model settings", "Models", "endpoints, main/sidecar pair, managed runtime", () => Run(ConfigureModels)),
            new("Check models", "Models", "what the endpoint advertises", () => Run(CheckModels)),
            new("Validate models", "Models", "prove the configured pair responds", () => Run(ValidateModels)),
            new("Model health", "Models", "responding, slow/loading, or unavailable", () => Run(ModelHealth)),
            new("Probe capabilities", "Models", "grammar, logprobs, context, prompt cache", () => Run(ProbeCapabilities)),
            new("Quick benchmark", "Models", "bounded responsiveness sample", () => Run(BenchmarkModels)),
            new("Coding probe", "Models", "sandboxed coding-quality battery", () => Run(CodingBenchmark)),
            new("Project probe", "Models", "held-out multi-file battery", () => Run(ProjectBenchmark)),
            new("Full bakeoff", "Models", "compare candidates and pick winners", () => Run(ModelBakeoff)),
            new("Last bakeoff report", "Models", "open the saved report", () => Run(ViewBakeoffReport)),

            new("Agent library", "Agents", "built-in and project subagents", () => Run(OpenAgentLibrary)),
            new("Task board", "Agents", "durable subagent DAG for this session", () => Run(OpenTaskBoard)),
            new("Sidecar toolbox", "Agents", "run one bounded sidecar job or pack", () => Run(OpenSidecarToolbox)),

            new("Export diagnostics", "Support", "redacted bundle for a bug report", () => Run(ExportDiagnostics)),
            new("Reconnect engine", "Support", "restart the hidden local engine", () => Run(RetryEngine)),
        };
        FilterPalette("");
    }

    private void ShowCommandPalette(object? sender, RoutedEventArgs e) => OpenPalette();

    /// <summary>Used by `--snapshot --palette` so the palette can be reviewed like any other surface.</summary>
    internal void OpenPaletteForSnapshot() => OpenPalette();

    private void OpenPalette()
    {
        if (_paletteCommands.Count == 0) BuildPalette();
        PaletteSearch.Text = "";
        FilterPalette("");
        PaletteOverlay.IsVisible = true;
        PaletteSearch.Focus();
    }

    private void ClosePalette()
    {
        PaletteOverlay.IsVisible = false;
        Prompt.Focus();
    }

    private void FilterPalette(string query)
    {
        _paletteVisible.Clear();
        var terms = query.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        foreach (var command in _paletteCommands)
        {
            var haystack = $"{command.Title} {command.Group} {command.Hint}";
            if (terms.All(term => haystack.Contains(term, StringComparison.OrdinalIgnoreCase))) _paletteVisible.Add(command);
        }
        PaletteList.ItemsSource = null;
        PaletteList.ItemsSource = _paletteVisible;
        if (_paletteVisible.Count > 0) PaletteList.SelectedIndex = 0;
    }

    private void InvokeSelectedPaletteCommand()
    {
        var command = PaletteList.SelectedItem as PaletteCommand ?? _paletteVisible.FirstOrDefault();
        ClosePalette();
        command?.Invoke();
    }

    private void PaletteInvoke(object? sender, RoutedEventArgs e) => InvokeSelectedPaletteCommand();

    private void PaletteKeyDown(object? sender, KeyEventArgs e)
    {
        switch (e.Key)
        {
            case Key.Escape:
                ClosePalette();
                e.Handled = true;
                return;
            case Key.Enter:
                InvokeSelectedPaletteCommand();
                e.Handled = true;
                return;
            case Key.Down:
                if (_paletteVisible.Count > 0) PaletteList.SelectedIndex = Math.Min(PaletteList.SelectedIndex + 1, _paletteVisible.Count - 1);
                e.Handled = true;
                return;
            case Key.Up:
                if (_paletteVisible.Count > 0) PaletteList.SelectedIndex = Math.Max(PaletteList.SelectedIndex - 1, 0);
                e.Handled = true;
                return;
        }
        // Filter after the keystroke has been applied to the box.
        Avalonia.Threading.Dispatcher.UIThread.Post(() => FilterPalette(PaletteSearch.Text ?? ""));
    }

    private void WindowKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Key == Key.K && e.KeyModifiers.HasFlag(KeyModifiers.Control))
        {
            if (PaletteOverlay.IsVisible) ClosePalette(); else OpenPalette();
            e.Handled = true;
            return;
        }
        if (e.Key == Key.Escape && PaletteOverlay.IsVisible)
        {
            ClosePalette();
            e.Handled = true;
        }
    }

    // ── Status surfaces ──────────────────────────────────────────────────────────────────────────
    // Small helpers so state is reported in one place instead of each handler poking at controls.

    private enum EngineState { Starting, Connected, Failed }

    private IBrush TokenBrush(string key, IBrush fallback)
    {
        if (this.TryFindResource(key, out var value) && value is IBrush brush) return brush;
        return fallback;
    }

    private void SetEngineState(EngineState state, string message)
    {
        ConnectionText.Text = message;
        ConnectionDot.Fill = state switch
        {
            EngineState.Connected => TokenBrush("OkBrush", Brushes.LightGreen),
            EngineState.Failed => TokenBrush("ErrBrush", Brushes.IndianRed),
            _ => TokenBrush("WarnBrush", Brushes.Goldenrod),
        };
    }

    /// <summary>
    /// The header names the project, it does not print its path: a deep temp path was the widest thing
    /// in the window and pushed everything else out. The full path stays available on hover.
    /// </summary>
    private void SetProject(string? projectRoot)
    {
        if (string.IsNullOrWhiteSpace(projectRoot))
        {
            ProjectText.Text = "No project";
            ToolTip.SetTip(ProjectText, null);
            return;
        }
        var trimmed = projectRoot.TrimEnd('\\', '/');
        var name = Path.GetFileName(trimmed);
        ProjectText.Text = string.IsNullOrEmpty(name) ? trimmed : name;
        ToolTip.SetTip(ProjectText, projectRoot);
    }

    private void ShowApproval(string text)
    {
        ApprovalText.Text = text;
        ApprovalBar.IsVisible = !string.IsNullOrWhiteSpace(text);
    }

    private void SetChangesSummary(int files, int added, int removed)
    {
        if (files == 0) { ChangesSummary.Text = "No changes in this run."; return; }
        var counted = files == 1 ? "1 file touched" : $"{files} files touched";
        // Replayed history knows which files changed but not the line deltas; do not print "+0 / -0".
        ChangesSummary.Text = added == 0 && removed == 0 ? counted : $"{counted}  ·  +{added} / -{removed} lines";
    }

    private void SetComposerHint(string text) => ComposerHint.Text = text;

    /// <summary>A run takes seconds or minutes; nobody reads "113748 ms".</summary>
    internal static string Duration(long milliseconds)
    {
        if (milliseconds <= 0) return "0s";
        if (milliseconds < 1000) return $"{milliseconds}ms";
        if (milliseconds < 60_000) return $"{milliseconds / 1000.0:0.0}s";
        var minutes = milliseconds / 60_000;
        var seconds = (milliseconds % 60_000) / 1000;
        return $"{minutes}m {seconds:00}s";
    }

    private void ShowBakeoffSection(bool visible) => BakeoffSection.IsVisible = visible || BakeoffSection.IsVisible;
}
