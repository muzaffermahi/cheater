using Avalonia;
using Avalonia.Controls;
using Avalonia.Controls.Primitives;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Platform.Storage;
using Avalonia.Threading;
using System.Text.Json;

namespace Kitten.Desktop;

/// <summary>
/// Settings as a place, not an event. Every setting used to live in one long modal dialog reached by
/// typing a command — you scrolled a single column past endpoints and model ids to reach the llama.cpp
/// knobs, and the runtime's log and launch command were a SECOND dialog somewhere else entirely.
///
/// This is the ordinary shape instead: the groups on the left, the selected group's controls on the
/// right, one Save. It also inverts the local-runtime flow. Choosing a server binary, naming the model
/// and sizing the launch are things Kitten can work out from the machine, so it does: the user picks
/// weights and, if they want to, the flags.
/// </summary>
public sealed class SettingsView
{
    private static readonly string[] Sections = { "Setup", "Behaviour", "Performance", "Advanced" };
    private static readonly string[] TriState = { "auto", "on", "off" };
    private static readonly string[] KvCacheTypes = { "auto", "q8_0", "f16", "q4_0" };
    private static readonly string[] LoadModes = { "auto", "mmap", "mlock", "mmap+mlock", "none" };
    private static readonly string[] SidecarDevices = { "cpu", "gpu" };
    private static readonly string[] MoeLayerModes =
    {
        "Automatic — let Kitten decide",
        "Off — keep every expert on the GPU",
        "A set number of layers on the CPU",
        "Every layer's experts on the CPU",
    };
    private static readonly string[] ApprovalPolicies = { "ask", "auto-allow", "auto-deny" };
    private static readonly string[] TaskCompilerModes = { "off", "auto", "force" };
    private static readonly string[] WebAccessModes = { "open", "allowlist", "off" };

    private readonly Func<Task<EngineClient?>> _engine;
    private readonly Window _owner;
    private readonly Func<string?> _projectRoot;
    private readonly Action<string> _report;
    private readonly Action _close;
    private readonly Func<Task> _afterSave;

    // ── Models ──────────────────────────────────────────────────────────────────────────────────
    private readonly TextBox _endpoint = new() { Watermark = "http://127.0.0.1:1234/v1" };
    private readonly TextBox _sidecarEndpoint = new();
    private readonly TextBox _mainModel = new();
    private readonly TextBox _sidecarModel = new();
    private readonly TextBlock _modelStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.75 };

    // ── Local runtime ───────────────────────────────────────────────────────────────────────────
    private readonly ComboBox _weightsList = new() { PlaceholderText = "Weights already on this machine…", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly TextBox _weightsPath = new();
    private readonly TextBlock _weightsSummary = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.8 };
    private readonly ComboBox _sidecarWeightsList = new() { PlaceholderText = "Optional 2B–9B sidecar weights…", HorizontalAlignment = HorizontalAlignment.Stretch };
    private readonly TextBox _sidecarWeightsPath = new();
    private readonly TextBox _executable = new();
    private readonly TextBlock _executableStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.75 };
    private readonly TextBlock _runtimeStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.75 };

    // ── Performance ─────────────────────────────────────────────────────────────────────────────
    private readonly TextBox _contextTokens = new() { Watermark = "auto (sized from your GPU) — or e.g. 32768", MinWidth = 220 };
    private readonly CheckBox _gpuLayersAuto = new() { Content = "Put every layer that fits on the GPU (recommended)", IsChecked = true };
    private readonly Slider _gpuLayers = new() { Minimum = 0, Maximum = 99, TickFrequency = 1, IsSnapToTickEnabled = true, Value = 99 };
    private readonly TextBlock _gpuLayersLabel = new() { FontSize = 11.5, Opacity = 0.75 };
    private readonly ComboBox _cpuMoeLayersMode = new() { ItemsSource = MoeLayerModes, SelectedIndex = 0, MinWidth = 300 };
    private readonly Slider _cpuMoeLayers = new() { Minimum = 1, Maximum = 99, TickFrequency = 1, IsSnapToTickEnabled = true, Value = 1 };
    private readonly TextBlock _cpuMoeLayersLabel = new() { FontSize = 11.5, Opacity = 0.75, TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock _tuneStatus = new() { FontSize = 11.5, Opacity = 0.8, TextWrapping = TextWrapping.Wrap };
    private readonly Button _tuneButton = new() { Content = "Tune for this machine" };
    private readonly Button _tuneCancel = new() { Content = "Stop", IsEnabled = false };
    private readonly ComboBox _flashAttn = new() { ItemsSource = TriState, SelectedIndex = 0, MinWidth = 140 };
    private readonly ComboBox _kvCacheType = new() { ItemsSource = KvCacheTypes, SelectedIndex = 0, MinWidth = 140 };
    private readonly ComboBox _kvOffload = new() { ItemsSource = TriState, SelectedIndex = 0, MinWidth = 140 };
    private readonly ComboBox _loadMode = new() { ItemsSource = LoadModes, SelectedIndex = 0, MinWidth = 180 };
    private readonly ComboBox _sidecarDevice = new() { ItemsSource = SidecarDevices, SelectedIndex = 0, MinWidth = 140 };
    private readonly TextBox _threads = new() { Watermark = "auto", MinWidth = 140 };
    private readonly TextBox _batchSize = new() { Watermark = "auto", MinWidth = 140 };
    private readonly TextBox _ubatchSize = new() { Watermark = "auto", MinWidth = 140 };
    private readonly TextBox _mainGpu = new() { Watermark = "auto", MinWidth = 140 };
    private readonly TextBox _tensorSplit = new() { Watermark = "auto — or e.g. 24,8", MinWidth = 220 };

    // ── Advanced ────────────────────────────────────────────────────────────────────────────────
    private readonly TextBox _extraArgs = new() { Watermark = "extra llama-server flags, appended last (they win)" };
    private readonly TextBox _argsOverride = new()
    {
        AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 84,
        FontFamily = new FontFamily("Cascadia Mono,Consolas,monospace"), FontSize = 11.5,
        Watermark = "empty — Kitten builds the command from the settings above",
    };
    private readonly SelectableTextBlock _commandPreview = new()
    {
        FontFamily = new FontFamily("Cascadia Mono,Consolas,monospace"), FontSize = 11.5,
        TextWrapping = TextWrapping.Wrap, Opacity = 0.85,
    };
    private readonly TextBlock _capabilities = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.7 };

    // ── Behaviour ───────────────────────────────────────────────────────────────────────────────
    private readonly ComboBox _approvalPolicy = new() { ItemsSource = ApprovalPolicies, SelectedIndex = 0, MinWidth = 180 };
    private readonly ComboBox _taskCompiler = new() { ItemsSource = TaskCompilerModes, SelectedIndex = 1, MinWidth = 180 };
    private readonly ComboBox _webAccess = new() { ItemsSource = WebAccessModes, SelectedIndex = 0, MinWidth = 180 };

    // ── Runtime & logs ──────────────────────────────────────────────────────────────────────────
    private readonly TextBlock _runtimeState = new() { TextWrapping = TextWrapping.Wrap, FontSize = 13 };
    private readonly TextBox _log = new()
    {
        IsReadOnly = true, AcceptsReturn = true, TextWrapping = TextWrapping.NoWrap, MinHeight = 300,
        FontFamily = new FontFamily("Cascadia Mono,Consolas,monospace"), FontSize = 11.5,
    };

    private readonly ListBox _nav = new() { ItemsSource = Sections, SelectedIndex = 0 };
    private readonly ContentControl _pane = new();
    private readonly TextBlock _saveStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.75, VerticalAlignment = VerticalAlignment.Center };
    private readonly Dictionary<string, Control> _panes = new();
    private readonly List<(string Path, string Display)> _modelChoices = new();
    private readonly TextBlock _catalogStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Opacity = 0.75 };
    private JsonElement[] _catalogEntries = Array.Empty<JsonElement>();
    private string? _activeDownloadId;
    private DispatcherTimer? _logPoll;
    private int _layerCount;
    private bool _loading;

    public Control Root { get; }

    public SettingsView(Func<Task<EngineClient?>> engine, Window owner, Func<string?> projectRoot, Action<string> report, Action close, Func<Task> afterSave)
    {
        _engine = engine;
        _owner = owner;
        _projectRoot = projectRoot;
        _report = report;
        _close = close;
        _afterSave = afterSave;

        foreach (var box in new[] { _endpoint, _sidecarEndpoint, _mainModel, _sidecarModel, _weightsPath, _sidecarWeightsPath, _executable, _extraArgs })
        {
            box.HorizontalAlignment = HorizontalAlignment.Stretch;
        }

        _panes["Setup"] = BuildSetupPane();
        _panes["Performance"] = BuildPerformancePane();
        _panes["Advanced"] = BuildAdvancedPane();
        _panes["Behaviour"] = BuildBehaviourPane();
        // The former six-pane wall is intentionally grouped into four task-oriented sections.
        // Runtime/log controls remain available inside Setup, while raw sampler knobs stay Advanced.

        _nav.SelectionChanged += (_, _) => ShowSelectedPane();
        _pane.Content = _panes[Sections[0]];

        // The sliders only mean something next to their own number, and the MoE slider is only live
        // when the user has actually asked for a custom split.
        _gpuLayers.PropertyChanged += (_, e) => { if (e.Property == RangeBase.ValueProperty) UpdateSliderLabels(); };
        _cpuMoeLayers.PropertyChanged += (_, e) => { if (e.Property == RangeBase.ValueProperty) UpdateSliderLabels(); };
        _gpuLayersAuto.PropertyChanged += (_, e) => { if (e.Property == ToggleButton.IsCheckedProperty) UpdateSliderLabels(); };
        _cpuMoeLayersMode.SelectionChanged += (_, _) => UpdateSliderLabels();

        Root = BuildRoot();
        UpdateSliderLabels();
    }

    // ── Layout ──────────────────────────────────────────────────────────────────────────────────

    private Control BuildRoot()
    {
        var save = new Button { Content = "Save settings", Classes = { "primary" } };
        var revert = new Button { Content = "Revert" };
        var close = new Button { Content = "Close" };
        save.Click += async (_, _) => await SaveAsync();
        revert.Click += async (_, _) => { await LoadAsync(); _saveStatus.Text = "Reloaded the saved settings."; };
        close.Click += (_, _) => _close();

        var nav = new Border
        {
            [Grid.ColumnProperty] = 0,
            Padding = new Thickness(12),
            Background = Themed("SurfaceBrush"),
            BorderBrush = Themed("BorderBrush2"),
            BorderThickness = new Thickness(0, 0, 1, 0),
            Child = new StackPanel
            {
                Spacing = 10,
                Children =
                {
                    new TextBlock { Text = "SETTINGS", Classes = { "label" } },
                    _nav,
                },
            },
        };

        var body = new DockPanel
        {
            [Grid.ColumnProperty] = 1,
            LastChildFill = true,
            Children =
            {
                new Border
                {
                    [DockPanel.DockProperty] = Dock.Bottom,
                    Padding = new Thickness(20, 10),
                    BorderThickness = new Thickness(0, 1, 0, 0),
                    BorderBrush = Themed("BorderBrush2"),
                    Child = new Grid
                    {
                        ColumnDefinitions = new ColumnDefinitions("Auto,*"),
                        ColumnSpacing = 12,
                        Children =
                        {
                            new StackPanel
                            {
                                Orientation = Orientation.Horizontal,
                                Spacing = 8,
                                Children = { save, revert, close },
                            },
                            SecondColumn(_saveStatus),
                        },
                    },
                },
                new ScrollViewer
                {
                    VerticalScrollBarVisibility = Avalonia.Controls.Primitives.ScrollBarVisibility.Auto,
                    Content = _pane,
                },
            },
        };

        var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("232,*") };
        grid.Children.Add(nav);
        grid.Children.Add(body);
        return grid;
    }

    /// <summary>Place a control in a grid's second column without a separate statement at each use.</summary>
    private static Control SecondColumn(Control control)
    {
        Grid.SetColumn(control, 1);
        return control;
    }

    /// <summary>A brush from the app theme, or null so the control keeps its default.</summary>
    private static IBrush? Themed(string key) => Application.Current?.FindResource(key) as IBrush;

    private static Control Pane(params Control[] children)
    {
        var stack = new StackPanel { Margin = new Thickness(24, 20), Spacing = 14 };
        foreach (var child in children) stack.Children.Add(child);
        return stack;
    }

    private Control BuildSetupPane()
    {
        return new StackPanel { Spacing = 18, Children = { BuildModelsPane(), BuildRuntimePane(), BuildLogPane() } };
    }

    private Control BuildModelsPane()
    {
        var findLocal = new Button { Content = "Find a local endpoint" };
        var discover = new Button { Content = "Read the endpoint's model list" };
        findLocal.Click += async (_, _) => await FindLocalEndpointAsync();
        discover.Click += async (_, _) => await DiscoverModelsAsync();
        return Pane(
            MainWindow.Section("Endpoint"),
            MainWindow.Hint("Any OpenAI-compatible server. Leave the sidecar endpoint blank to share the main one."),
            MainWindow.Field("Main endpoint", _endpoint),
            MainWindow.Field("Sidecar endpoint (optional)", _sidecarEndpoint),
            MainWindow.ButtonRow(findLocal, discover),
            _modelStatus,
            MainWindow.Section("Model ids"),
            MainWindow.Hint("The names Kitten asks for. A managed runtime fills these in from your weights."),
            MainWindow.Field("Main model (35B–200B)", _mainModel),
            MainWindow.Field("Sidecar model (2B–9B)", _sidecarModel));
    }

    private Control BuildRuntimePane()
    {
        var browseWeights = new Button { Content = "Browse…" };
        var rescan = new Button { Content = "Rescan folders" };
        var browseSidecar = new Button { Content = "Browse…" };
        var changeRuntime = new Button { Content = "Choose a different llama-server…" };
        var redetect = new Button { Content = "Detect again" };
        var start = new Button { Content = "Start / restart runtime", Classes = { "primary" } };
        var stop = new Button { Content = "Stop runtime" };

        browseWeights.Click += async (_, _) => { if (await PickModelFileAsync() is { } picked) { _weightsPath.Text = picked; await InspectWeightsAsync(); } };
        browseSidecar.Click += async (_, _) => { if (await PickModelFileAsync() is { } picked) _sidecarWeightsPath.Text = picked; };
        rescan.Click += async (_, _) => await ScanModelFilesAsync();
        redetect.Click += async (_, _) => await AutoconfigureAsync(apply: true);
        changeRuntime.Click += async (_, _) =>
        {
            var files = await _owner.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                AllowMultiple = false,
                Title = "Choose the llama-server executable",
                FileTypeFilter = new[] { new FilePickerFileType("Executable") { Patterns = new[] { "*.exe", "*" } } },
            });
            if (files.Count > 0) { _executable.Text = files[0].Path.LocalPath; _executableStatus.Text = "Using the executable you chose. Save to keep it."; }
        };
        start.Click += async (_, _) => await StartRuntimeAsync(start);
        stop.Click += async (_, _) => await StopRuntimeAsync(stop);

        _weightsList.SelectionChanged += async (_, _) =>
        {
            if (_loading) return;
            var index = _weightsList.SelectedIndex;
            if (index < 0 || index >= _modelChoices.Count) return;
            _weightsPath.Text = _modelChoices[index].Path;
            await InspectWeightsAsync();
        };
        _sidecarWeightsList.SelectionChanged += (_, _) =>
        {
            if (_loading) return;
            var index = _sidecarWeightsList.SelectedIndex;
            if (index >= 0 && index < _modelChoices.Count) _sidecarWeightsPath.Text = _modelChoices[index].Path;
        };

        return Pane(
            MainWindow.Section("Weights"),
            MainWindow.Hint("The one choice that is really yours. Kitten reads the file, names the model, finds a server, and sizes the launch to your GPU."),
            MainWindow.Field("Main model weights", _weightsList),
            MainWindow.Field("…or a path", MainWindow.PathRow(_weightsPath, browseWeights, rescan)),
            _weightsSummary,
            MainWindow.Section("Sidecar weights (optional)"),
            MainWindow.Hint("A small model for clerical work, on the CPU so it takes no VRAM from the main one."),
            MainWindow.Field("Sidecar weights", _sidecarWeightsList),
            MainWindow.Field("…or a path", MainWindow.PathRow(_sidecarWeightsPath, browseSidecar)),
            MainWindow.Section("Server"),
            MainWindow.Hint("Found automatically — beside the app, in your LM Studio backends, or on PATH."),
            _executableStatus,
            MainWindow.Field("llama-server executable", _executable),
            MainWindow.ButtonRow(changeRuntime, redetect),
            MainWindow.Section("Control"),
            MainWindow.ButtonRow(start, stop),
            _runtimeStatus,
            BuildCatalogSection());
    }

    /// <summary>Checksum-verified downloads from an imported catalog — the "I have no weights yet" path.</summary>
    private Control BuildCatalogSection()
    {
        var import = new Button { Content = "Import a catalog (.json)" };
        var download = new Button { Content = "Download its models", IsEnabled = false };
        var cancel = new Button { Content = "Cancel download", IsEnabled = false };
        import.Click += async (_, _) => await ImportCatalogAsync(download);
        cancel.Click += async (_, _) => await CancelDownloadAsync(cancel);
        download.Click += async (_, _) => await DownloadCatalogAsync(download, cancel);
        return new StackPanel
        {
            Spacing = 14,
            Children =
            {
                MainWindow.Section("Get weights"),
                MainWindow.Hint("A catalog lists verified weights. Every download is checked against its published hash."),
                MainWindow.ButtonRow(import, download, cancel),
                _catalogStatus,
            },
        };
    }

    private async Task ImportCatalogAsync(Button download)
    {
        var engine = await EngineAsync(_catalogStatus);
        if (engine is null) return;
        var files = await _owner.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            AllowMultiple = false,
            Title = "Import a Kitten model catalog",
            FileTypeFilter = new[] { new FilePickerFileType("JSON catalog") { Patterns = new[] { "*.json" } } },
        });
        if (files.Count == 0) return;
        try
        {
            await using var stream = await files[0].OpenReadAsync();
            using var reader = new StreamReader(stream);
            var raw = await reader.ReadToEndAsync();
            var catalog = await engine.CallAsync("model.catalog", new { raw });
            if (catalog is not { } value || value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("entries", out var entries) || entries.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidOperationException("the catalog contains no entries");
            }
            _catalogEntries = entries.EnumerateArray().ToArray();
            download.IsEnabled = _catalogEntries.Length > 0;
            foreach (var entry in _catalogEntries)
            {
                var role = Text(entry, "role");
                var id = Text(entry, "id");
                if (string.IsNullOrWhiteSpace(id)) continue;
                if (string.Equals(role, "main", StringComparison.OrdinalIgnoreCase)) _mainModel.Text = id;
                else if (string.Equals(role, "sidecar", StringComparison.OrdinalIgnoreCase)) _sidecarModel.Text = id;
            }
            _catalogStatus.Text = $"Imported {_catalogEntries.Length} verified entr{(_catalogEntries.Length == 1 ? "y" : "ies")}. Review the ids under Models, then download.";
        }
        catch (Exception ex) { _catalogStatus.Text = $"The catalog could not be imported: {Explain(ex)}"; }
    }

    private async Task CancelDownloadAsync(Button cancel)
    {
        if (_activeDownloadId is null) return;
        var engine = await EngineAsync(_catalogStatus);
        if (engine is null) return;
        cancel.IsEnabled = false;
        _catalogStatus.Text = "Cancelling the download…";
        try { await engine.CallAsync("model.download.cancel", new { id = _activeDownloadId }); }
        catch (Exception ex) { _catalogStatus.Text = $"The download could not be cancelled: {Explain(ex)}"; }
    }

    private async Task DownloadCatalogAsync(Button download, Button cancel)
    {
        if (_catalogEntries.Length == 0) return;
        var engine = await EngineAsync(_catalogStatus);
        if (engine is null) return;
        var folders = await _owner.StorageProvider.OpenFolderPickerAsync(new FolderPickerOpenOptions { AllowMultiple = false, Title = "Where should the weights be stored?" });
        if (folders.Count == 0) return;
        download.IsEnabled = false;
        cancel.IsEnabled = true;
        try
        {
            var folder = folders[0].Path.LocalPath;
            for (var index = 0; index < _catalogEntries.Length; index++)
            {
                var entry = _catalogEntries[index];
                var id = Text(entry, "id");
                if (string.IsNullOrWhiteSpace(id)) id = $"model-{index + 1}";
                var format = Text(entry, "format");
                var safeName = string.Concat(id.Select(character => Path.GetInvalidFileNameChars().Contains(character) || character is '/' or '\\' ? '_' : character));
                var destination = Path.Combine(folder, $"{safeName}.{(format == "safetensors" ? "safetensors" : "gguf")}");
                _activeDownloadId = $"catalog-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds():x}-{index}";
                _catalogStatus.Text = $"Downloading {index + 1} of {_catalogEntries.Length}: {id}";
                _report($"Downloading catalog model {index + 1}/{_catalogEntries.Length}: {id}");
                await engine.CallAsync("model.download", new { id = _activeDownloadId, entry, destination });
                var role = Text(entry, "role");
                if (string.Equals(role, "main", StringComparison.OrdinalIgnoreCase)) _weightsPath.Text = destination;
                else if (string.Equals(role, "sidecar", StringComparison.OrdinalIgnoreCase)) _sidecarWeightsPath.Text = destination;
            }
            _catalogStatus.Text = $"Downloaded {_catalogEntries.Length} model(s), each verified against its published checksum.";
            await ScanModelFilesAsync();
            await InspectWeightsAsync();
        }
        catch (Exception ex)
        {
            var cancelled = ex.Message.Contains("cancel", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("abort", StringComparison.OrdinalIgnoreCase);
            _catalogStatus.Text = cancelled ? "The download was cancelled." : $"The download failed: {Explain(ex)}";
        }
        finally
        {
            _activeDownloadId = null;
            download.IsEnabled = true;
            cancel.IsEnabled = false;
        }
    }

    private Control BuildPerformancePane()
    {
        var suggest = new Button { Content = "Use the suggested split" };
        suggest.Click += async (_, _) => await SuggestMoeSplitAsync();
        _tuneButton.Click += async (_, _) => await CalibrateAsync();
        _tuneCancel.Click += async (_, _) =>
        {
            var engine = await EngineAsync(_tuneStatus);
            if (engine is null) return;
            try { await engine.CallAsync("runtime.calibrate.cancel"); } catch { /* the run ends either way */ }
        };
        return Pane(
            MainWindow.Section("Context"),
            MainWindow.Hint("Sized for the work, not for the largest window that fits — context is VRAM the experts need. Kitten grows it only when the card has room to spare."),
            MainWindow.Field("Context tokens (--ctx-size)", _contextTokens),
            MainWindow.Section("Layers on the GPU"),
            MainWindow.Hint("How many layers live in VRAM. Everything that fits is almost always right."),
            _gpuLayersAuto,
            _gpuLayers,
            _gpuLayersLabel,
            MainWindow.Section("Expert layers on the CPU"),
            MainWindow.Hint("Experts are most of a MoE model's weight and the part that will not fit. Sending the first N layers' experts to the CPU keeps the rest on the GPU — that split is most of your speed. For a 35B on 8 GB, 30 of 40 is typical."),
            _cpuMoeLayersMode,
            _cpuMoeLayers,
            _cpuMoeLayersLabel,
            MainWindow.ButtonRow(suggest),
            MainWindow.Section("Measured tuning"),
            MainWindow.Hint("Loads the model a few times, times each split, keeps the fastest. A few minutes, remembered afterwards — the exact edge depends on your driver, which no formula can see."),
            MainWindow.ButtonRow(_tuneButton, _tuneCancel),
            _tuneStatus,
            MainWindow.Section("Attention and cache"),
            MainWindow.Field("Flash attention (--flash-attn)", _flashAttn),
            MainWindow.Field("KV cache type (--cache-type-k/v)", _kvCacheType),
            MainWindow.Field("Keep the KV cache on the GPU", _kvOffload),
            MainWindow.Section("CPU and loading"),
            MainWindow.Field("CPU threads (--threads)", _threads),
            MainWindow.Field("Batch size (--batch-size)", _batchSize),
            MainWindow.Field("Micro-batch size (--ubatch-size)", _ubatchSize),
            MainWindow.Field("Model loading (--load-mode)", _loadMode),
            MainWindow.Section("Multiple GPUs"),
            MainWindow.Field("Main GPU index (--main-gpu)", _mainGpu),
            MainWindow.Field("Split across GPUs (--tensor-split)", _tensorSplit),
            MainWindow.Section("Sidecar"),
            MainWindow.Field("Sidecar device", _sidecarDevice));
    }

    private Control BuildAdvancedPane()
    {
        var preview = new Button { Content = "Preview the launch command" };
        var adopt = new Button { Content = "Copy it into the pinned command" };
        var clear = new Button { Content = "Unpin — use Kitten's plan" };
        preview.Click += async (_, _) => await PreviewCommandAsync();
        adopt.Click += async (_, _) =>
        {
            await PreviewCommandAsync();
            var text = _commandPreview.Text ?? "";
            var newline = text.IndexOf('\n');
            _argsOverride.Text = (newline >= 0 ? text[..newline] : text).Replace("llama-server ", "", StringComparison.Ordinal).Trim();
        };
        clear.Click += (_, _) => { _argsOverride.Text = ""; _saveStatus.Text = "The pinned command is cleared. Save to go back to Kitten's plan."; };
        return Pane(
            MainWindow.Section("Extra flags"),
            MainWindow.Hint("Appended last, so they win. For anything the fields above do not cover."),
            MainWindow.Field("Extra llama-server flags", _extraArgs),
            MainWindow.Section("Pinned command"),
            MainWindow.Hint("Replaces the generated command entirely. While set, nothing in Performance applies."),
            _argsOverride,
            MainWindow.ButtonRow(clear),
            MainWindow.Section("Preview"),
            MainWindow.Hint("Exactly what your llama-server would receive, including flags this build would skip."),
            MainWindow.ButtonRow(preview, adopt),
            _commandPreview,
            _capabilities);
    }

    private Control BuildBehaviourPane() => Pane(
        MainWindow.Section("Approvals"),
        MainWindow.Hint("Whether Kitten asks before acting outside the workspace."),
        MainWindow.Field("Approval policy", _approvalPolicy),
        MainWindow.Section("Planning"),
        MainWindow.Hint("Turns a request into an explicit contract before any code is written."),
        MainWindow.Field("Task compiler", _taskCompiler),
        MainWindow.Section("Web access"),
        MainWindow.Hint("How far the web tools may reach: any site, reference documentation only, or nothing."),
        MainWindow.Field("Web access", _webAccess));

    private Control BuildLogPane()
    {
        var refresh = new Button { Content = "Refresh" };
        var copy = new Button { Content = "Copy log" };
        refresh.Click += async (_, _) => await RefreshRuntimeLogAsync();
        copy.Click += async (_, _) =>
        {
            try { if (_owner.Clipboard is not null) await _owner.Clipboard.SetTextAsync(_log.Text ?? ""); }
            catch { /* the clipboard is a convenience, never a failure worth reporting */ }
        };
        return Pane(
            MainWindow.Section("Runtime"),
            _runtimeState,
            MainWindow.ButtonRow(refresh, copy),
            MainWindow.Section("Server log"),
            MainWindow.Hint("llama-server's own words — the ground truth when a load fails."),
            _log);
    }

    private void ShowSelectedPane()
    {
        var name = _nav.SelectedItem as string ?? Sections[0];
        if (_panes.TryGetValue(name, out var pane)) _pane.Content = pane;
        // The log only polls while it is on screen; a settings panel has no business holding a timer
        // against the engine for a pane nobody is looking at.
        if (name is "Setup" or "Runtime & logs") StartLogPolling();
        else StopLogPolling();
        if (name == "Advanced" && string.IsNullOrWhiteSpace(_commandPreview.Text)) _ = PreviewCommandAsync();
    }

    public void Select(string section)
    {
        var canonical = section is "Models" or "Local runtime" or "Runtime & logs" ? "Setup" : section;
        var index = Array.IndexOf(Sections, canonical);
        if (index >= 0) _nav.SelectedIndex = index;
    }

    // ── Visibility ──────────────────────────────────────────────────────────────────────────────

    public void OnHidden() => StopLogPolling();

    private void StartLogPolling()
    {
        if (_logPoll is not null) return;
        _logPoll = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        _logPoll.Tick += async (_, _) => await RefreshRuntimeLogAsync();
        _logPoll.Start();
        _ = RefreshRuntimeLogAsync();
    }

    private void StopLogPolling()
    {
        _logPoll?.Stop();
        _logPoll = null;
    }

    // ── Load ────────────────────────────────────────────────────────────────────────────────────

    public async Task LoadAsync()
    {
        var engine = await EngineAsync(_saveStatus);
        if (engine is null) return;
        _loading = true;
        try
        {
            var current = await engine.CallAsync("settings.inspect", new { projectRoot = _projectRoot() });
            if (current is { } value && value.ValueKind == JsonValueKind.Object) ApplySettings(value);
        }
        catch (Exception ex) { _saveStatus.Text = $"Could not read the current settings: {Explain(ex)}"; }
        finally { _loading = false; }

        await ScanModelFilesAsync();
        await AutoconfigureAsync(apply: false);
        await InspectWeightsAsync();
        _saveStatus.Text = "";
    }

    private void ApplySettings(JsonElement value)
    {
        if (value.TryGetProperty("models", out var models) && models.ValueKind == JsonValueKind.Object)
        {
            _endpoint.Text = Text(models, "baseUrl");
            _sidecarEndpoint.Text = Text(models, "sidecarBaseUrl");
            _mainModel.Text = Text(models, "main");
            _sidecarModel.Text = Text(models, "sidecar");
        }
        if (value.TryGetProperty("managedRuntime", out var managed) && managed.ValueKind == JsonValueKind.Object)
        {
            _executable.Text = Text(managed, "executable");
            _weightsPath.Text = Text(managed, "mainModelPath");
            _sidecarWeightsPath.Text = Text(managed, "sidecarModelPath");
        }
        _contextTokens.Text = value.TryGetProperty("contextWindowTokens", out var ctx) && ctx.ValueKind == JsonValueKind.Number
            ? ctx.GetInt32().ToString()
            : "auto";
        SelectValue(_approvalPolicy, Text(value, "approvalPolicy"), "ask");
        SelectValue(_taskCompiler, Text(value, "taskCompiler"), "auto");
        SelectValue(_webAccess, Text(value, "webAccess"), "open");
        if (value.TryGetProperty("runtimeTuning", out var tuning) && tuning.ValueKind == JsonValueKind.Object)
        {
            SelectValue(_flashAttn, Text(tuning, "flashAttn"), "auto");
            SelectValue(_kvCacheType, Text(tuning, "kvCacheType"), "auto");
            SelectValue(_kvOffload, Text(tuning, "kvOffload"), "auto");
            SelectValue(_loadMode, Text(tuning, "loadMode"), "auto");
            SelectValue(_sidecarDevice, Text(tuning, "sidecarDevice"), "cpu");
            _threads.Text = CountText(tuning, "threads");
            _batchSize.Text = CountText(tuning, "batchSize");
            _ubatchSize.Text = CountText(tuning, "ubatchSize");
            _mainGpu.Text = CountText(tuning, "mainGpu");
            _tensorSplit.Text = Text(tuning, "tensorSplit");
            _extraArgs.Text = Text(tuning, "extraArgs");
            _argsOverride.Text = Text(tuning, "argsOverride");

            var gpuLayers = tuning.TryGetProperty("gpuLayers", out var layers) && layers.ValueKind == JsonValueKind.Number ? layers.GetInt32() : -1;
            _gpuLayersAuto.IsChecked = gpuLayers < 0;
            if (gpuLayers >= 0) _gpuLayers.Value = Math.Min(gpuLayers, _gpuLayers.Maximum);

            // The two saved fields (whether, and how many) collapse back into the single choice on screen.
            var moeOff = string.Equals(Text(tuning, "cpuMoe"), "off", StringComparison.Ordinal);
            if (moeOff) _cpuMoeLayersMode.SelectedIndex = 1;
            else if (tuning.TryGetProperty("cpuMoeLayers", out var moeLayers) && moeLayers.ValueKind == JsonValueKind.Number)
            {
                _cpuMoeLayersMode.SelectedIndex = 2;
                _cpuMoeLayers.Value = Math.Max(_cpuMoeLayers.Minimum, Math.Min(moeLayers.GetInt32(), _cpuMoeLayers.Maximum));
            }
            else _cpuMoeLayersMode.SelectedIndex = string.Equals(Text(tuning, "cpuMoeLayers"), "all", StringComparison.Ordinal) ? 3 : 0;
        }
        UpdateSliderLabels();
    }

    /// <summary>What the machine already provides: the server binary, the weights, the hardware.</summary>
    private async Task AutoconfigureAsync(bool apply)
    {
        var engine = await EngineAsync(_executableStatus);
        if (engine is null) return;
        try
        {
            var found = await engine.CallAsync("runtime.autoconfig", new { projectRoot = _projectRoot(), apply });
            if (found is not { } value || value.ValueKind != JsonValueKind.Object) return;
            var executable = Text(value, "executable");
            var autoDetected = value.TryGetProperty("executableAutoDetected", out var auto) && auto.ValueKind == JsonValueKind.True;
            if (!string.IsNullOrWhiteSpace(executable) && (string.IsNullOrWhiteSpace(_executable.Text) || apply)) _executable.Text = executable;
            _executableStatus.Text = string.IsNullOrWhiteSpace(executable)
                ? "No llama-server was found on this machine. Choose one below, or use an endpoint you start yourself."
                : autoDetected ? $"Found automatically: {executable}" : $"Using: {executable}";

            if (string.IsNullOrWhiteSpace(_weightsPath.Text))
            {
                var weights = Text(value, "mainModelPath");
                if (!string.IsNullOrWhiteSpace(weights)) _weightsPath.Text = weights;
            }
            var warnings = ReadStrings(value, "warnings");
            if (warnings.Length > 0) _runtimeStatus.Text = string.Join("\n", warnings);
        }
        catch (Exception ex) { _executableStatus.Text = $"Automatic setup failed: {Explain(ex)}"; }
    }

    /// <summary>Read the picked .gguf: layer count, size, the id it should be served under.</summary>
    private async Task InspectWeightsAsync()
    {
        var path = (_weightsPath.Text ?? "").Trim();
        if (path.Length == 0) { _weightsSummary.Text = "No weights chosen yet."; return; }
        var engine = await EngineAsync(_weightsSummary);
        if (engine is null) return;
        try
        {
            var found = await engine.CallAsync("model.inspect-weights", new { path, projectRoot = _projectRoot() });
            if (found is not { } value || value.ValueKind != JsonValueKind.Object) return;
            var name = Text(value, "name");
            var bytes = value.TryGetProperty("bytes", out var size) && size.ValueKind == JsonValueKind.Number ? size.GetInt64() : 0;
            var architecture = Text(value, "architecture");
            var layers = value.TryGetProperty("layerCount", out var layerCount) && layerCount.ValueKind == JsonValueKind.Number ? layerCount.GetInt32() : 0;
            var trained = value.TryGetProperty("trainedContextTokens", out var trainedCtx) && trainedCtx.ValueKind == JsonValueKind.Number ? trainedCtx.GetInt32() : 0;
            var vram = value.TryGetProperty("vramBytes", out var vramValue) && vramValue.ValueKind == JsonValueKind.Number ? vramValue.GetInt64() : 0;
            var suggestedId = Text(value, "suggestedModelId");

            _layerCount = layers;
            if (layers > 0)
            {
                _gpuLayers.Maximum = layers;
                _cpuMoeLayers.Maximum = layers;
                if (_gpuLayersAuto.IsChecked == true) _gpuLayers.Value = layers;
            }

            var parts = new List<string> { name, $"{bytes / 1e9:0.0} GB" };
            if (!string.IsNullOrWhiteSpace(architecture)) parts.Add(architecture);
            if (layers > 0) parts.Add($"{layers} layers");
            if (trained > 0) parts.Add($"trained for {trained:n0} tokens");
            if (vram > 0) parts.Add($"{vram / 1e9:0.0} GB VRAM on this machine");
            var summary = string.Join("  ·  ", parts);
            if (value.TryGetProperty("suggested", out var suggested) && suggested.ValueKind == JsonValueKind.Object)
            {
                var reason = Text(suggested, "reason");
                if (!string.IsNullOrWhiteSpace(reason)) summary += $"\n{reason}";
                if (suggested.TryGetProperty("cpuMoeLayers", out var moe) && moe.ValueKind == JsonValueKind.Number)
                {
                    summary += $"\nThese weights do not fit VRAM: the experts of about {moe.GetInt32()} layers need to run on the CPU. Performance → Mixture-of-experts offload.";
                }
            }
            _weightsSummary.Text = summary;

            // Naming the model is bookkeeping, not a decision — fill it in when the user has not.
            if (!string.IsNullOrWhiteSpace(suggestedId) && string.IsNullOrWhiteSpace(_mainModel.Text)) _mainModel.Text = suggestedId;
            UpdateSliderLabels();
        }
        catch (Exception ex) { _weightsSummary.Text = $"Could not read these weights: {Explain(ex)}"; }
    }

    private async Task ScanModelFilesAsync()
    {
        var engine = await EngineAsync(_weightsSummary);
        if (engine is null) return;
        try
        {
            var files = await engine.CallAsync("model.files", new { projectRoot = _projectRoot() });
            _modelChoices.Clear();
            if (files is { } list && list.ValueKind == JsonValueKind.Array)
            {
                foreach (var file in list.EnumerateArray())
                {
                    var path = Text(file, "path");
                    if (string.IsNullOrWhiteSpace(path)) continue;
                    var bytes = file.TryGetProperty("bytes", out var size) && size.ValueKind == JsonValueKind.Number ? size.GetInt64() : 0;
                    _modelChoices.Add((path, $"{Text(file, "name")}   ({bytes / 1e9:0.0} GB)"));
                }
            }
            var display = _modelChoices.Select(choice => choice.Display).ToArray();
            var wasLoading = _loading;
            _loading = true;
            try
            {
                _weightsList.ItemsSource = display;
                _sidecarWeightsList.ItemsSource = display;
                _weightsList.SelectedIndex = IndexOfPath(_weightsPath.Text);
                _sidecarWeightsList.SelectedIndex = IndexOfPath(_sidecarWeightsPath.Text);
            }
            finally { _loading = wasLoading; }
            if (display.Length == 0) _weightsSummary.Text = "No .gguf files were found beside the configured weights or in the LM Studio folders. Use Browse.";
        }
        catch (Exception ex) { _weightsSummary.Text = $"Could not scan for weights: {Explain(ex)}"; }
    }

    private int IndexOfPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return -1;
        return _modelChoices.FindIndex(choice => string.Equals(choice.Path, path, StringComparison.OrdinalIgnoreCase));
    }

    // ── Actions ─────────────────────────────────────────────────────────────────────────────────

    private async Task<string?> PickModelFileAsync()
    {
        var files = await _owner.StorageProvider.OpenFilePickerAsync(new FilePickerOpenOptions
        {
            AllowMultiple = false,
            Title = "Choose model weights",
            FileTypeFilter = new[] { new FilePickerFileType("Model weights") { Patterns = new[] { "*.gguf" } } },
        });
        return files.Count > 0 ? files[0].Path.LocalPath : null;
    }

    private async Task FindLocalEndpointAsync()
    {
        var engine = await EngineAsync(_modelStatus);
        if (engine is null) return;
        _modelStatus.Text = "Checking the usual local ports…";
        try
        {
            var found = await engine.CallAsync("model.local-discover", new { timeoutMs = 900 });
            if (found is { } value && value.ValueKind == JsonValueKind.Array && value.GetArrayLength() > 0)
            {
                var first = value.EnumerateArray().FirstOrDefault(item => item.ValueKind == JsonValueKind.Object);
                var baseUrl = first.ValueKind == JsonValueKind.Object ? Text(first, "baseUrl") : "";
                if (!string.IsNullOrWhiteSpace(baseUrl))
                {
                    _endpoint.Text = baseUrl;
                    _modelStatus.Text = $"Found {baseUrl}. Read its model list to fill in the ids.";
                    return;
                }
            }
            _modelStatus.Text = "Nothing answered on the usual ports. Start a local server, or let Kitten manage one from Local runtime.";
        }
        catch (Exception ex) { _modelStatus.Text = $"The scan failed: {Explain(ex)}"; }
    }

    private async Task DiscoverModelsAsync()
    {
        var engine = await EngineAsync(_modelStatus);
        if (engine is null) return;
        _modelStatus.Text = "Asking the endpoint what it serves…";
        try
        {
            var found = await engine.CallAsync("model.discover", new { baseUrl = _endpoint.Text });
            if (found is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("models", out var models) && models.ValueKind == JsonValueKind.Array)
            {
                var ids = models.EnumerateArray().Select(item => Text(item, "id")).Where(id => !string.IsNullOrWhiteSpace(id)).ToArray();
                if (ids.Length == 0) { _modelStatus.Text = "The endpoint answered but advertises no models."; return; }
                if (string.IsNullOrWhiteSpace(_mainModel.Text)) _mainModel.Text = ids[0];
                _modelStatus.Text = $"It serves: {string.Join(", ", ids)}";
                return;
            }
            _modelStatus.Text = "The endpoint could not be queried. Check that the server is running.";
        }
        catch (Exception ex) { _modelStatus.Text = $"Discovery failed: {Explain(ex)}"; }
    }

    private async Task SuggestMoeSplitAsync()
    {
        var path = (_weightsPath.Text ?? "").Trim();
        if (path.Length == 0) { _cpuMoeLayersLabel.Text = "Choose weights first — the split depends on the model's size and layer count."; return; }
        var engine = await EngineAsync(_cpuMoeLayersLabel);
        if (engine is null) return;
        try
        {
            var found = await engine.CallAsync("model.inspect-weights", new { path, projectRoot = _projectRoot() });
            if (found is { } value && value.ValueKind == JsonValueKind.Object && value.TryGetProperty("suggested", out var suggested) && suggested.ValueKind == JsonValueKind.Object
                && suggested.TryGetProperty("cpuMoeLayers", out var layers))
            {
                if (layers.ValueKind == JsonValueKind.Number)
                {
                    _cpuMoeLayersMode.SelectedIndex = 2; // a set number of layers
                    _cpuMoeLayers.Value = Math.Max(_cpuMoeLayers.Minimum, Math.Min(layers.GetInt32(), _cpuMoeLayers.Maximum));
                }
                else if (layers.ValueKind == JsonValueKind.String) _cpuMoeLayersMode.SelectedIndex = 3; // all of them
                else _cpuMoeLayersMode.SelectedIndex = 1; // it fits: keep the experts on the GPU
                UpdateSliderLabels();
                return;
            }
            _cpuMoeLayersLabel.Text = "These weights fit in VRAM as they are; no expert offload is needed.";
        }
        catch (Exception ex) { _cpuMoeLayersLabel.Text = $"Could not work out a split: {Explain(ex)}"; }
    }

    /// <summary>
    /// Measure this machine. The estimate is a starting point; only a real timing run finds the exact
    /// point where the card starts spilling, and that point is worth about 10% of throughput.
    /// </summary>
    private async Task CalibrateAsync()
    {
        var engine = await EngineAsync(_tuneStatus);
        if (engine is null) return;
        _tuneButton.IsEnabled = false;
        _tuneCancel.IsEnabled = true;
        _tuneStatus.Text = "Measuring… this stops the running model and loads it a few times. You can leave the panel open.";
        try
        {
            var result = await engine.CallAsync("runtime.calibrate", new { projectRoot = _projectRoot() });
            if (result is { } value && value.ValueKind == JsonValueKind.Object)
            {
                var layers = value.TryGetProperty("cpuMoeLayers", out var best) && best.ValueKind == JsonValueKind.Number ? best.GetInt32() : 0;
                var decode = value.TryGetProperty("decodeTokensPerSecond", out var dec) && dec.ValueKind == JsonValueKind.Number ? dec.GetDouble() : 0;
                var prefill = value.TryGetProperty("promptTokensPerSecond", out var pre) && pre.ValueKind == JsonValueKind.Number ? pre.GetDouble() : 0;
                _tuneStatus.Text = $"Measured: {layers} layers of experts on the CPU — {decode:0.0} tokens/s writing, {prefill:0} tokens/s reading. Kitten will use this from now on.";
                await LoadAsync();
            }
        }
        catch (Exception ex) { _tuneStatus.Text = $"Tuning stopped: {Explain(ex)}"; }
        finally { _tuneButton.IsEnabled = true; _tuneCancel.IsEnabled = false; }
    }

    /// <summary>Live progress from a calibration run, so a multi-minute measurement is never silent.</summary>
    public void OnCalibrationProgress(JsonElement payload)
    {
        var step = payload.TryGetProperty("step", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetInt32() : 0;
        var total = payload.TryGetProperty("total", out var t) && t.ValueKind == JsonValueKind.Number ? t.GetInt32() : 0;
        var layers = payload.TryGetProperty("cpuMoeLayers", out var l) && l.ValueKind == JsonValueKind.Number ? l.GetInt32() : 0;
        var decode = payload.TryGetProperty("decodeTokensPerSecond", out var d) && d.ValueKind == JsonValueKind.Number ? d.GetDouble() : 0;
        var note = Text(payload, "note");
        _tuneStatus.Text = decode > 0
            ? $"[{step}/{total}] {layers} layers on the CPU → {decode:0.0} tokens/s"
            : !string.IsNullOrWhiteSpace(note)
                ? $"[{step}/{total}] {layers} layers on the CPU — {note}"
                : $"[{step}/{total}] loading with {layers} layers on the CPU…";
    }

    private async Task PreviewCommandAsync()
    {
        var engine = await EngineAsync(_commandPreview);
        if (engine is null) return;
        try
        {
            var plan = await engine.CallAsync("model.launch-plan", new
            {
                projectRoot = _projectRoot(),
                mainModel = string.IsNullOrWhiteSpace(_mainModel.Text) ? null : _mainModel.Text,
                mainModelPath = string.IsNullOrWhiteSpace(_weightsPath.Text) ? null : _weightsPath.Text,
                executable = string.IsNullOrWhiteSpace(_executable.Text) ? null : _executable.Text,
                contextTokens = int.TryParse((_contextTokens.Text ?? "").Trim(), out var ctx) && ctx > 0 ? (int?)ctx : null,
                tuning = TuningPayload(CollectTuning()),
            });
            if (plan is not { } value || value.ValueKind != JsonValueKind.Object) return;
            var args = value.TryGetProperty("args", out var argv) && argv.ValueKind == JsonValueKind.Array
                ? argv.EnumerateArray().Select(item => item.GetString() ?? "").Select(part => part.Contains(' ') ? $"\"{part}\"" : part)
                : Enumerable.Empty<string>();
            var warnings = ReadStrings(value, "warnings");
            _commandPreview.Text = $"llama-server {string.Join(" ", args)}";
            _capabilities.Text = warnings.Length > 0 ? string.Join("\n", warnings.Select(warning => "· " + warning)) : "";
        }
        catch (Exception ex) { _commandPreview.Text = $"Preview failed: {Explain(ex)}"; }
    }

    private async Task StartRuntimeAsync(Button start)
    {
        var engine = await EngineAsync(_runtimeStatus);
        if (engine is null) return;
        start.IsEnabled = false;
        _runtimeStatus.Text = "Saving these settings, then starting the runtime. A large model can take minutes to load — the log in Runtime & logs is live.";
        try
        {
            await SaveAsync(quiet: true);
            var result = await engine.CallAsync("runtime.ensure", new { projectRoot = _projectRoot() });
            var configured = result is { } value && value.ValueKind == JsonValueKind.Object
                && (!value.TryGetProperty("configured", out var flag) || flag.ValueKind != JsonValueKind.False);
            _runtimeStatus.Text = configured
                ? "The runtime is starting. Watch Runtime & logs for its own output."
                : "Kitten still needs model weights before it can start a runtime.";
            await _afterSave();
        }
        catch (Exception ex) { _runtimeStatus.Text = $"The runtime did not start: {Explain(ex)}"; }
        finally { start.IsEnabled = true; }
    }

    private async Task StopRuntimeAsync(Button stop)
    {
        var engine = await EngineAsync(_runtimeStatus);
        if (engine is null) return;
        stop.IsEnabled = false;
        try
        {
            await engine.CallAsync("runtime.stop");
            _runtimeStatus.Text = "The managed runtime is stopped.";
            await _afterSave();
        }
        catch (Exception ex) { _runtimeStatus.Text = $"Stopping the runtime failed: {Explain(ex)}"; }
        finally { stop.IsEnabled = true; }
    }

    private async Task RefreshRuntimeLogAsync()
    {
        // The log polls on a timer, so it takes the handle without reporting or reconnecting: a
        // background poll must never narrate, and never race the user's own reconnect.
        var engine = await _engine();
        if (engine is null) return;
        try
        {
            var log = await engine.CallAsync("runtime.log", new { maxLines = 300 });
            if (log is not { } value || value.ValueKind != JsonValueKind.Object) return;
            var text = Text(value, "main");
            if (_log.Text != text)
            {
                _log.Text = string.IsNullOrWhiteSpace(text) ? "(the runtime has not written anything yet)" : text;
                _log.CaretIndex = _log.Text.Length;
            }
            var running = value.TryGetProperty("running", out var runningValue) && runningValue.ValueKind == JsonValueKind.True;
            var state = value.TryGetProperty("state", out var stateValue) && stateValue.ValueKind == JsonValueKind.Object ? stateValue : default;
            _runtimeState.Text = DescribeState(state, running);
        }
        catch (Exception ex) { _runtimeState.Text = $"The runtime status is unavailable: {Explain(ex)}"; }
    }

    private static string DescribeState(JsonElement state, bool running)
    {
        if (state.ValueKind != JsonValueKind.Object) return running ? "The runtime process is running." : "No managed runtime is running.";
        var phase = Text(state, "phase");
        var model = Text(state, "model");
        var ctx = state.TryGetProperty("ctxTokens", out var ctxValue) && ctxValue.ValueKind == JsonValueKind.Number ? ctxValue.GetInt32() : 0;
        var elapsed = state.TryGetProperty("elapsedMs", out var elapsedValue) && elapsedValue.ValueKind == JsonValueKind.Number ? elapsedValue.GetInt64() : 0;
        var elapsedText = elapsed > 0 ? $" ({elapsed / 1000}s so far)" : "";
        return phase switch
        {
            "loading" => $"Loading {model} into memory{elapsedText}. This is normal for a large model — Kitten waits rather than giving up.",
            "starting" or "probing" => $"Starting {model}{elapsedText}…",
            "ready" => $"Ready · {model}{(ctx > 0 ? $" · {ctx:n0} context tokens" : "")}",
            "external" => $"A server outside Kitten is already serving {model}. Kitten uses it as it is.",
            "stopped" => "The runtime is stopped.",
            "failed" => "The runtime failed — its own last words are in the log below.",
            _ => running ? "The runtime process is running." : "No managed runtime is running.",
        };
    }

    // ── Save ────────────────────────────────────────────────────────────────────────────────────

    /// <summary>
    /// The llama.cpp knobs as they stand on screen. One snapshot serves both the preview and the save,
    /// so the command a user is shown is built from exactly the values that get written.
    /// </summary>
    private sealed record TuningSnapshot(
        object GpuLayers, string CpuMoe, object CpuMoeLayers, string FlashAttn, string KvCacheType, string KvOffload,
        object Threads, object BatchSize, object UbatchSize, string LoadMode, object MainGpu, string TensorSplit,
        string SidecarDevice, string ExtraArgs, string ArgsOverride);

    private TuningSnapshot CollectTuning() => new(
        GpuLayers: _gpuLayersAuto.IsChecked == true ? "auto" : (object)(int)_gpuLayers.Value,
        CpuMoe: _cpuMoeLayersMode.SelectedIndex switch { 1 => "off", 2 or 3 => "on", _ => "auto" },
        CpuMoeLayers: _cpuMoeLayersMode.SelectedIndex switch { 2 => (object)(int)_cpuMoeLayers.Value, 3 => "all", _ => "auto" },
        FlashAttn: Selected(_flashAttn, "auto"),
        KvCacheType: Selected(_kvCacheType, "auto"),
        KvOffload: Selected(_kvOffload, "auto"),
        Threads: CountOrAuto(_threads),
        BatchSize: CountOrAuto(_batchSize),
        UbatchSize: CountOrAuto(_ubatchSize),
        LoadMode: Selected(_loadMode, "auto"),
        MainGpu: CountOrAuto(_mainGpu),
        TensorSplit: Trimmed(_tensorSplit),
        SidecarDevice: Selected(_sidecarDevice, "cpu"),
        ExtraArgs: Trimmed(_extraArgs),
        ArgsOverride: Trimmed(_argsOverride));

    /// <summary>The wire shape the engine's tuning parser expects.</summary>
    private static object TuningPayload(TuningSnapshot tuning) => new
    {
        gpuLayers = tuning.GpuLayers,
        cpuMoe = tuning.CpuMoe,
        cpuMoeLayers = tuning.CpuMoeLayers,
        flashAttn = tuning.FlashAttn,
        kvCacheType = tuning.KvCacheType,
        kvOffload = tuning.KvOffload,
        threads = tuning.Threads,
        batchSize = tuning.BatchSize,
        ubatchSize = tuning.UbatchSize,
        loadMode = tuning.LoadMode,
        mainGpu = tuning.MainGpu,
        tensorSplit = tuning.TensorSplit,
        extraArgs = tuning.ExtraArgs,
        argsOverride = tuning.ArgsOverride,
    };

    public async Task SaveAsync(bool quiet = false)
    {
        var engine = await EngineAsync(_saveStatus);
        if (engine is null) return;
        var tuning = CollectTuning();
        var projectRoot = _projectRoot();
        try
        {
            await engine.CallAsync("settings.update", new
            {
                // With a project open these are that project's settings. Without one there is nothing
                // to scope them to, so they belong to the user — writing them into whatever directory
                // the engine happened to start in is how a setting "saves" and then disappears.
                scope = string.IsNullOrWhiteSpace(projectRoot) ? "user" : "project",
                projectRoot,
                update = new
                {
                    baseUrl = Trimmed(_endpoint),
                    sidecarBaseUrl = Trimmed(_sidecarEndpoint),
                    mainModel = Trimmed(_mainModel),
                    sidecarModel = Trimmed(_sidecarModel),
                    runtimeExecutable = Trimmed(_executable),
                    mainModelPath = Trimmed(_weightsPath),
                    sidecarModelPath = Trimmed(_sidecarWeightsPath),
                    contextWindowTokens = int.TryParse((_contextTokens.Text ?? "").Trim(), out var ctx) && ctx > 0 ? (object)ctx : "auto",
                    approvalPolicy = Selected(_approvalPolicy, "ask"),
                    taskCompiler = Selected(_taskCompiler, "auto"),
                    webAccess = Selected(_webAccess, "open"),
                    gpuLayers = tuning.GpuLayers,
                    cpuMoe = tuning.CpuMoe,
                    cpuMoeLayers = tuning.CpuMoeLayers,
                    flashAttn = tuning.FlashAttn,
                    kvCacheType = tuning.KvCacheType,
                    kvOffload = tuning.KvOffload,
                    threads = tuning.Threads,
                    batchSize = tuning.BatchSize,
                    ubatchSize = tuning.UbatchSize,
                    loadMode = tuning.LoadMode,
                    mainGpu = tuning.MainGpu,
                    tensorSplit = tuning.TensorSplit,
                    sidecarDevice = tuning.SidecarDevice,
                    extraArgs = tuning.ExtraArgs,
                    argsOverride = tuning.ArgsOverride,
                },
            });
            await _afterSave();
            _saveStatus.Text = "Saved. Restart the runtime to apply anything that changes the launch.";
            if (!quiet) _report("Settings saved. Restart the runtime to apply launch changes.");
        }
        catch (Exception ex)
        {
            _saveStatus.Text = $"Could not save: {Explain(ex)}";
            if (!quiet) _report($"Could not save settings: {Explain(ex)}");
        }
    }

    // ── Small helpers ───────────────────────────────────────────────────────────────────────────

    private void UpdateSliderLabels()
    {
        var auto = _gpuLayersAuto.IsChecked == true;
        _gpuLayers.IsEnabled = !auto;
        _gpuLayersLabel.Text = auto
            ? _layerCount > 0 ? $"Every layer that fits — up to all {_layerCount}." : "Every layer that fits."
            : $"{(int)_gpuLayers.Value}{(_layerCount > 0 ? $" of {_layerCount}" : "")} layers in VRAM{((int)_gpuLayers.Value == 0 ? " — a pure CPU load" : "")}.";

        var custom = _cpuMoeLayersMode.SelectedIndex == 2;
        _cpuMoeLayers.IsEnabled = custom;
        var total = _layerCount > 0 ? $" of {_layerCount}" : "";
        _cpuMoeLayersLabel.Text = _cpuMoeLayersMode.SelectedIndex switch
        {
            1 => "Every expert stays on the GPU. Fastest when the weights fit; it will not load when they do not.",
            2 => $"The experts of the first {(int)_cpuMoeLayers.Value}{total} layers run on the CPU; every other expert stays on the GPU.",
            3 => "Every expert runs on the CPU. Always fits, and the slowest of the choices.",
            _ => "Kitten works out the fewest layers that let everything else fit in VRAM.",
        };
    }

    /// <summary>
    /// A live engine, reconnecting if the background process dropped, with the wait explained in the
    /// panel the user is looking at. Silence here is what turned a restarted engine into a wall of
    /// "Object reference not set to an instance of an object".
    /// </summary>
    private async Task<EngineClient?> EngineAsync(TextBlock report)
    {
        var engine = await _engine();
        if (engine is null) report.Text = "Kitten's background engine is not running yet. It is being restarted \u2014 try that again in a moment.";
        return engine;
    }

    /// <summary>Engine failures arrive as a JSON envelope around escaped stderr. Show the sentence.</summary>
    private static string Explain(Exception error) => MainWindow.SummariseEngineError(error.Message);

    private static string Trimmed(TextBox box) => (box.Text ?? "").Trim();

    private static object CountOrAuto(TextBox box) => int.TryParse((box.Text ?? "").Trim(), out var value) && value >= 0 ? (object)value : "auto";

    private static string Selected(ComboBox box, string fallback) => box.SelectedItem as string ?? fallback;

    private static void SelectValue(ComboBox box, string? value, string fallback)
    {
        var items = box.ItemsSource as string[] ?? Array.Empty<string>();
        var index = Array.IndexOf(items, string.IsNullOrWhiteSpace(value) ? fallback : value);
        if (index >= 0) box.SelectedIndex = index;
    }

    private static string Text(JsonElement parent, string key) =>
        parent.ValueKind == JsonValueKind.Object && parent.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "" : "";

    private static string CountText(JsonElement parent, string key) =>
        parent.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetInt32().ToString() : "auto";

    private static string[] ReadStrings(JsonElement parent, string key) =>
        parent.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.EnumerateArray().Select(item => item.GetString()).Where(item => !string.IsNullOrWhiteSpace(item)).Cast<string>().ToArray()
            : Array.Empty<string>();
}
