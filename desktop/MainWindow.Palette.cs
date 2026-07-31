using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Documents;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Layout;
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

    /// <summary>
    /// Submit a real task for `--snapshot --task "…"`. This is the one path that cannot be reviewed from
    /// replayed history: streaming into the open card, tool steps arriving live, Stop becoming available.
    /// </summary>
    internal void SubmitForSnapshot(string text)
    {
        Prompt.Text = text;
        Submit(this, new RoutedEventArgs());
    }

    /// <summary>Open one secondary surface by name for `--snapshot --view <name>`, so every screen the
    /// app can show is reviewable without a human driving the mouse.</summary>
    internal void OpenViewForSnapshot(string view)
    {
        if (_paletteCommands.Count == 0) BuildPalette();
        var wanted = view.Replace('-', ' ').Trim();
        var command = _paletteCommands.FirstOrDefault(entry => entry.Title.StartsWith(wanted, StringComparison.OrdinalIgnoreCase))
            ?? _paletteCommands.FirstOrDefault(entry => entry.Title.Contains(wanted, StringComparison.OrdinalIgnoreCase));
        if (command is null)
        {
            Console.Error.WriteLine($"unknown snapshot view '{view}'. Available: {string.Join(", ", _paletteCommands.Select(entry => entry.Title))}");
            return;
        }
        command.Invoke();
    }

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

    // ── Dialog building blocks ───────────────────────────────────────────────────────────────────
    // Secondary surfaces are built in code, so they need shared pieces or every one drifts into its own
    // layout — unlabelled inputs, button rows that overflow the window, no visible structure.

    /// <summary>A small-caps section heading, matching the inspector's labels.</summary>
    internal static Control Section(string title) => new TextBlock { Text = title.ToUpperInvariant(), Classes = { "label" }, Margin = new Thickness(0, 6, 0, 0) };

    internal static Control Hint(string text) => new TextBlock { Text = text, Classes = { "body" }, TextWrapping = TextWrapping.Wrap };

    /// <summary>A labelled field. A watermark is not a label: it disappears as soon as there is a value.</summary>
    internal static Control Field(string label, Control input) => new StackPanel
    {
        Spacing = 4,
        Children = { new TextBlock { Text = label, FontSize = 11.5, Opacity = 0.75, TextWrapping = TextWrapping.Wrap }, input },
    };

    /// <summary>Buttons that wrap instead of running off the edge of the window.</summary>
    internal static Control ButtonRow(params Control[] buttons)
    {
        var panel = new WrapPanel { Orientation = Orientation.Horizontal, ItemSpacing = 8, LineSpacing = 8 };
        foreach (var button in buttons) panel.Children.Add(button);
        return panel;
    }

    /// <summary>A path input that takes the free space, with its browse buttons pinned to the right.</summary>
    internal static Control PathRow(Control input, params Control[] buttons)
    {
        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("*,Auto"), ColumnSpacing = 8 };
        grid.Children.Add(input);
        var side = new WrapPanel { Orientation = Orientation.Horizontal, ItemSpacing = 8, LineSpacing = 8 };
        foreach (var button in buttons) side.Children.Add(button);
        Grid.SetColumn(side, 1);
        grid.Children.Add(side);
        return grid;
    }

    /// <summary>
    /// A diff has to be coloured to be readable — scanning a monochrome wall of +/- lines for what
    /// changed is exactly the work the view is supposed to do for you. One control with a run per line
    /// keeps it selectable and cheap even for a bounded 240 KB diff.
    /// </summary>
    internal static SelectableTextBlock DiffBody() => new()
    {
        FontFamily = new FontFamily("Cascadia Mono,Consolas,Menlo,monospace"),
        FontSize = 12,
        TextWrapping = TextWrapping.NoWrap,
    };

    internal static void SetDiff(SelectableTextBlock target, string diff)
    {
        var added = new SolidColorBrush(Color.Parse("#7ee2a8"));
        var removed = new SolidColorBrush(Color.Parse("#f4837f"));
        var hunk = new SolidColorBrush(Color.Parse("#7dd3fc"));
        var meta = new SolidColorBrush(Color.Parse("#6a6a74"));
        var body = new SolidColorBrush(Color.Parse("#c9c9d1"));
        target.Inlines?.Clear();
        if (string.IsNullOrWhiteSpace(diff))
        {
            target.Inlines?.Add(new Run("No tracked diff.") { Foreground = meta });
            return;
        }
        foreach (var line in diff.Replace("\r\n", "\n").Split('\n'))
        {
            var brush = body;
            if (line.StartsWith("@@", StringComparison.Ordinal)) brush = hunk;
            else if (line.StartsWith("+++", StringComparison.Ordinal) || line.StartsWith("---", StringComparison.Ordinal)
                || line.StartsWith("diff ", StringComparison.Ordinal) || line.StartsWith("index ", StringComparison.Ordinal)
                || line.StartsWith("new file", StringComparison.Ordinal) || line.StartsWith("deleted file", StringComparison.Ordinal)
                || line.StartsWith("similarity", StringComparison.Ordinal) || line.StartsWith("rename ", StringComparison.Ordinal)) brush = meta;
            else if (line.StartsWith("+", StringComparison.Ordinal)) brush = added;
            else if (line.StartsWith("-", StringComparison.Ordinal)) brush = removed;
            target.Inlines?.Add(new Run(line + "\n") { Foreground = brush });
        }
    }

    /// <summary>
    /// Render the durable subagent DAG as readable rows. This used to serialise the raw array, so an
    /// empty plan showed the user the two characters "[]".
    /// </summary>
    internal static string DescribeTaskNodes(System.Text.Json.JsonElement? result)
    {
        if (result is not { } value || value.ValueKind != System.Text.Json.JsonValueKind.Array || value.GetArrayLength() == 0)
        {
            return "No subagent tasks in this session yet.\n\nUse \"Plan with sidecar\" on a task, or @agent in the composer, to create one.";
        }
        var lines = new List<string>();
        foreach (var node in value.EnumerateArray())
        {
            string Read(string name) => node.TryGetProperty(name, out var found) && found.ValueKind == System.Text.Json.JsonValueKind.String ? found.GetString() ?? "" : "";
            string[] ReadList(string name) => node.TryGetProperty(name, out var found) && found.ValueKind == System.Text.Json.JsonValueKind.Array
                ? found.EnumerateArray().Where(item => item.ValueKind == System.Text.Json.JsonValueKind.String).Select(item => item.GetString() ?? "").Where(item => item.Length > 0).ToArray()
                : Array.Empty<string>();

            var status = Read("status");
            var mark = status switch { "completed" => "✓", "failed" => "✗", "running" => "▶", "cancelled" => "⊘", "blocked" => "…", _ => "•" };
            lines.Add($"{mark} {Read("agent")}  ·  {status}  ·  {Read("modelTier")} tier  ·  {Read("workspaceMode")}");
            var objective = Read("objective").Replace("\r", "").Split('\n').FirstOrDefault() ?? "";
            if (objective.Length > 0) lines.Add($"    {(objective.Length > 150 ? objective.Substring(0, 150) + "…" : objective)}");
            var dependencies = ReadList("dependencies");
            if (dependencies.Length > 0) lines.Add($"    after: {string.Join(", ", dependencies)}");
            var allowed = ReadList("allowedFiles");
            if (allowed.Length > 0) lines.Add($"    files: {string.Join(", ", allowed.Take(6))}{(allowed.Length > 6 ? $" (+{allowed.Length - 6})" : "")}");
            var report = Read("report").Replace("\r", "").Split('\n').FirstOrDefault() ?? "";
            if (report.Length > 0) lines.Add($"    report: {(report.Length > 150 ? report.Substring(0, 150) + "…" : report)}");
            lines.Add("");
        }
        return string.Join("\n", lines).TrimEnd();
    }

    /// <summary>Search hits as readable rows. This surface used to print the raw JSON array.</summary>
    internal static string DescribeSearchHits(System.Text.Json.JsonElement? result)
    {
        if (result is not { } value || value.ValueKind != System.Text.Json.JsonValueKind.Array || value.GetArrayLength() == 0) return "No matches.";
        var lines = new List<string>();
        foreach (var hit in value.EnumerateArray())
        {
            var path = hit.TryGetProperty("path", out var pathValue) ? pathValue.GetString() ?? "?" : "?";
            var symbols = hit.TryGetProperty("symbols", out var symbolsValue) && symbolsValue.ValueKind == System.Text.Json.JsonValueKind.Array
                ? symbolsValue.EnumerateArray().Where(item => item.ValueKind == System.Text.Json.JsonValueKind.String).Select(item => item.GetString() ?? "").Where(item => item.Length > 0).Take(8).ToArray()
                : Array.Empty<string>();
            lines.Add(path);
            if (symbols.Length > 0) lines.Add($"    {string.Join(", ", symbols)}");
            if (hit.TryGetProperty("lines", out var previewValue) && previewValue.ValueKind == System.Text.Json.JsonValueKind.Array)
            {
                foreach (var preview in previewValue.EnumerateArray().Take(2))
                {
                    var text = preview.ValueKind == System.Text.Json.JsonValueKind.String ? preview.GetString() ?? "" : preview.ToString();
                    text = text.Replace("\r", "").Replace("\n", " ").Trim();
                    if (text.Length > 0) lines.Add($"    {(text.Length > 140 ? text.Substring(0, 140) + "…" : text)}");
                }
            }
        }
        return string.Join("\n", lines);
    }

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
