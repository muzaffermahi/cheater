using Avalonia.Controls;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;
using System.Text.Json;

namespace Kitten.Desktop;

/// <summary>
/// The runtime control room: what the model process is doing RIGHT NOW (state, elapsed load time,
/// its own live log), the full llama.cpp flag surface, and the exact command line — editable before
/// it runs. This exists because "managed" must never mean "opaque": if Kitten launches llama-server
/// on the user's behalf, the user gets to see and change every argument, and read the server's own
/// words when something fails.
/// </summary>
public sealed class RuntimePanel
{
    private readonly EngineClient _engine;
    private readonly Window _owner;
    private readonly string? _projectRoot;

    private readonly TextBlock _state = new() { FontSize = 13, TextWrapping = TextWrapping.Wrap };
    private readonly TextBox _log = new()
    {
        IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap,
        FontFamily = new FontFamily("Cascadia Mono,Consolas,monospace"), FontSize = 11.5, MinHeight = 260,
    };
    private readonly TextBox _command = new()
    {
        AcceptsReturn = true, TextWrapping = TextWrapping.Wrap,
        FontFamily = new FontFamily("Cascadia Mono,Consolas,monospace"), FontSize = 11.5, MinHeight = 90,
    };
    private readonly TextBlock _capabilities = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.75 };
    private DispatcherTimer? _poll;

    public RuntimePanel(EngineClient engine, Window owner, string? projectRoot)
    {
        _engine = engine;
        _owner = owner;
        _projectRoot = projectRoot;
    }

    public async Task ShowAsync()
    {
        var refresh = new Button { Content = "Refresh" };
        var start = new Button { Content = "Start / restart runtime", Classes = { "primary" } };
        var stop = new Button { Content = "Stop runtime" };
        var copyLog = new Button { Content = "Copy log" };
        var close = new Button { Content = "Close" };

        var body = new StackPanel
        {
            Margin = new Avalonia.Thickness(20),
            Spacing = 12,
            Children =
            {
                new TextBlock { Text = "RUNTIME", FontSize = 11, FontWeight = FontWeight.SemiBold, Opacity = 0.6 },
                _state,
                new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Children = { start, stop, refresh, copyLog } },
                new TextBlock { Text = "LAUNCH COMMAND", FontSize = 11, FontWeight = FontWeight.SemiBold, Opacity = 0.6, Margin = new Avalonia.Thickness(0, 8, 0, 0) },
                new TextBlock { Text = "The exact arguments Kitten will pass to llama-server. Edit freely — what you see here is what runs, and it is saved as your extra flags.", TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.7 },
                _command,
                _capabilities,
                new TextBlock { Text = "SERVER LOG", FontSize = 11, FontWeight = FontWeight.SemiBold, Opacity = 0.6, Margin = new Avalonia.Thickness(0, 8, 0, 0) },
                new TextBlock { Text = "llama-server's own output, live. This is the ground truth when a load fails.", TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.7 },
                _log,
            },
        };

        var dialog = new Window
        {
            Title = "Kitten runtime",
            Width = 900,
            Height = 760,
            MinWidth = 620,
            MinHeight = 460,
            Icon = _owner.Icon,
            WindowStartupLocation = WindowStartupLocation.CenterOwner,
            Content = new DockPanel
            {
                LastChildFill = true,
                Children =
                {
                    new Border
                    {
                        [DockPanel.DockProperty] = Dock.Bottom,
                        Padding = new Avalonia.Thickness(20, 10),
                        BorderThickness = new Avalonia.Thickness(0, 1, 0, 0),
                        BorderBrush = new SolidColorBrush(Color.Parse("#26262e")),
                        Child = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right, Children = { close } },
                    },
                    new ScrollViewer { VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto, Content = body },
                },
            },
        };

        close.Click += (_, _) => dialog.Close();
        refresh.Click += async (_, _) => await RefreshAsync();
        copyLog.Click += async (_, _) => { try { if (dialog.Clipboard is not null) await dialog.Clipboard.SetTextAsync(_log.Text ?? ""); } catch { /* clipboard optional */ } };
        stop.Click += async (_, _) =>
        {
            stop.IsEnabled = false;
            try { await _engine.CallAsync("runtime.stop"); } catch (Exception ex) { _state.Text = $"Stop failed: {ex.Message}"; }
            finally { stop.IsEnabled = true; await RefreshAsync(); }
        };
        start.Click += async (_, _) =>
        {
            start.IsEnabled = false;
            _state.Text = "Starting the runtime… a large model can take minutes to load; the log below is live.";
            try
            {
                // Persist any hand-edited flags first, so what the user sees is literally what runs.
                await SaveEditedCommandAsync();
                await _engine.CallAsync("runtime.ensure", new { projectRoot = _projectRoot });
            }
            catch (Exception ex) { _state.Text = $"Start failed: {ex.Message}"; }
            finally { start.IsEnabled = true; await RefreshAsync(); }
        };

        await RefreshAsync();
        // While the window is open, follow the runtime live — this is where a user watches a load.
        _poll = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _poll.Tick += async (_, _) => await RefreshAsync(preserveCommandEdits: true);
        _poll.Start();
        dialog.Closed += (_, _) => { _poll?.Stop(); _poll = null; };
        await dialog.ShowDialog(_owner);
    }

    /// <summary>Everything on screen comes from the engine: state, the planned command, the real log.</summary>
    private async Task RefreshAsync(bool preserveCommandEdits = false)
    {
        try
        {
            var log = await _engine.CallAsync("runtime.log", new { maxLines = 300 });
            if (log is { } logValue && logValue.ValueKind == JsonValueKind.Object)
            {
                var text = logValue.TryGetProperty("main", out var mainLog) ? mainLog.GetString() ?? "" : "";
                if (_log.Text != text)
                {
                    _log.Text = string.IsNullOrWhiteSpace(text) ? "(the runtime has not written anything yet)" : text;
                    _log.CaretIndex = _log.Text.Length;
                }
                var running = logValue.TryGetProperty("running", out var runningValue) && runningValue.ValueKind == JsonValueKind.True;
                var state = logValue.TryGetProperty("state", out var stateValue) && stateValue.ValueKind == JsonValueKind.Object ? stateValue : default;
                _state.Text = DescribeState(state, running);
            }
        }
        catch (Exception ex) { _state.Text = $"Runtime status unavailable: {ex.Message}"; }

        if (preserveCommandEdits && !string.IsNullOrWhiteSpace(_command.Text)) return;
        try
        {
            var plan = await _engine.CallAsync("model.launch-plan", new { projectRoot = _projectRoot });
            if (plan is { } planned && planned.ValueKind == JsonValueKind.Object && planned.TryGetProperty("args", out var argv) && argv.ValueKind == JsonValueKind.Array)
            {
                var parts = argv.EnumerateArray().Select(item => item.GetString() ?? "").Select(part => part.Contains(' ') ? $"\"{part}\"" : part);
                _command.Text = string.Join(" ", parts);
                var planWarnings = planned.TryGetProperty("warnings", out var warningList) && warningList.ValueKind == JsonValueKind.Array
                    ? warningList.EnumerateArray().Select(item => item.GetString()).Where(item => !string.IsNullOrWhiteSpace(item)).ToArray()
                    : Array.Empty<string?>();
                _capabilities.Text = planWarnings.Length > 0 ? string.Join("\n", planWarnings.Select(w => "· " + w)) : "";
            }
        }
        catch { /* the plan is advisory here */ }

        try
        {
            var caps = await _engine.CallAsync("runtime.capabilities", new { projectRoot = _projectRoot });
            if (caps is { } capsValue && capsValue.ValueKind == JsonValueKind.Object && capsValue.TryGetProperty("flags", out var flags) && flags.ValueKind == JsonValueKind.Array)
            {
                var count = flags.GetArrayLength();
                var prefix = count > 0 ? $"This llama-server build advertises {count} flags; Kitten only emits ones it knows.\n" : "";
                _capabilities.Text = prefix + _capabilities.Text;
            }
        }
        catch { /* capability probing is advisory */ }
    }

    /// <summary>Save hand-edited arguments as the project's extra flags (they append last and win).</summary>
    private async Task SaveEditedCommandAsync()
    {
        var edited = (_command.Text ?? "").Trim();
        if (edited.Length == 0) return;
        try
        {
            await _engine.CallAsync("settings.update", new
            {
                scope = "project",
                projectRoot = _projectRoot,
                update = new { extraArgs = edited },
            });
        }
        catch { /* a save failure must not block the start attempt */ }
    }

    private static string DescribeState(JsonElement state, bool running)
    {
        if (state.ValueKind != JsonValueKind.Object) return running ? "Runtime process is running." : "No managed runtime is running.";
        var phase = state.TryGetProperty("phase", out var phaseValue) ? phaseValue.GetString() ?? "" : "";
        var model = state.TryGetProperty("model", out var modelValue) ? modelValue.GetString() ?? "" : "";
        var ctx = state.TryGetProperty("ctxTokens", out var ctxValue) && ctxValue.ValueKind == JsonValueKind.Number ? ctxValue.GetInt32() : 0;
        var elapsed = state.TryGetProperty("elapsedMs", out var elapsedValue) && elapsedValue.ValueKind == JsonValueKind.Number ? elapsedValue.GetInt64() : 0;
        var elapsedText = elapsed > 0 ? $" ({elapsed / 1000}s so far)" : "";
        return phase switch
        {
            "loading" => $"Loading {model} into memory{elapsedText}. This is normal for a large model — Kitten waits instead of giving up.",
            "starting" or "probing" => $"Starting {model}{elapsedText}…",
            "ready" => $"Ready · {model}{(ctx > 0 ? $" · {ctx:n0} context tokens" : "")}",
            "external" => $"An endpoint outside Kitten is serving {model}. Kitten uses it as-is.",
            "stopped" => "Runtime stopped.",
            "failed" => "Runtime failed — the server's own last words are in the log below.",
            _ => running ? "Runtime process is running." : "No managed runtime is running.",
        };
    }
}
