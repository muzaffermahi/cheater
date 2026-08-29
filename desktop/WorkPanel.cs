using Avalonia;
using Avalonia.Collections;
using Avalonia.Controls;
using Avalonia.Media.Imaging;
using Avalonia.Platform;
using Avalonia.Controls.Shapes;
using Avalonia.Layout;
using Avalonia.Media;
using Avalonia.Threading;

namespace Kitten.Desktop;

/// <summary>
/// Who is working, and on what — the top of the right pane.
///
/// A local model can spend a minute on its first token, and for that minute the app looked asleep:
/// one line of prose that only changed when something finished. Two things fix that, and both have to
/// be TRUE rather than decorative. A ring that turns only while a request is genuinely in flight, so
/// motion means "alive" and stillness means "idle" — never a spinner left running over a dead run.
/// And a row per worker, because Kitten is not one model: the main model reasons on the GPU while the
/// sidecar does clerical work on the CPU and subagents run their own conversations. That was entirely
/// invisible, so the app looked like a single black box that occasionally emitted text.
/// </summary>
public sealed class WorkPanel
{
    /// <summary>What one worker is doing right now. `Detail` is the honest specific, not a category.</summary>
    private sealed class Worker
    {
        public required string Key;
        public required Border Row;
        public required Ellipse Dot;
        public required TextBlock Name;
        public required TextBlock Detail;
        public required TextBlock Elapsed;
        /// <summary>The second line: what a subagent was actually asked to do, and what it came back with.</summary>
        public TextBlock? Note;
        public required StackPanel Body;
        public DateTimeOffset StartedAt = DateTimeOffset.UtcNow;
        public bool Active;
    }

    private static readonly IBrush TextBrush = new SolidColorBrush(Color.Parse("#e8e8ec"));
    private static readonly IBrush Muted = new SolidColorBrush(Color.Parse("#9a9aa4"));
    private static readonly IBrush Faint = new SolidColorBrush(Color.Parse("#6a6a74"));
    private static readonly IBrush Accent = new SolidColorBrush(Color.Parse("#e0a15c"));
    private static readonly IBrush Ok = new SolidColorBrush(Color.Parse("#6ee7a8"));
    private static readonly IBrush Err = new SolidColorBrush(Color.Parse("#f4837f"));

    private const string MainKey = "main";
    private const string SidecarKey = "sidecar";

    private readonly Image _mascot;
    private readonly TransformGroup _mascotMotion = new();
    private readonly RotateTransform _tilt = new();
    private readonly TranslateTransform _bob = new();
    private readonly ScaleTransform _breathe = new() { ScaleX = 1, ScaleY = 1 };
    private readonly Ellipse _ring;
    private readonly RotateTransform _spin = new();
    private double _phase;
    private readonly TextBlock _headline;
    private readonly TextBlock _meta;
    private readonly StackPanel _workers;
    private readonly DispatcherTimer _ticker = new() { Interval = TimeSpan.FromMilliseconds(60) };
    private readonly Dictionary<string, Worker> _byKey = new(StringComparer.Ordinal);

    private DateTimeOffset _startedAt = DateTimeOffset.UtcNow;
    private bool _running;
    private int _tools;
    private int _subagents;
    private int _candidates;
    private string _mainModel = "";
    private string _sidecarModel = "";

    public Control Root { get; }

    /// <summary>The animated mascot, hosted beside the composer rather than in the side pane.</summary>
    public Control Mascot { get; }

    public WorkPanel()
    {
        // A ring drawn as a dashed circle: one visible arc chasing the rest of the circumference. It
        // costs one transform per frame, which is what lets it run at 16 fps without heating a laptop
        // that is already busy running a 35B.
        _ring = new Ellipse
        {
            Width = 15, Height = 15, StrokeThickness = 2,
            Stroke = Accent, StrokeDashArray = new AvaloniaList<double> { 5.5, 4.5 },
            RenderTransform = _spin, IsVisible = false,
            VerticalAlignment = VerticalAlignment.Center,
        };
        // The kitten itself, bobbing and tilting while there is work in flight. It is the same honesty
        // rule as the ring — motion means a request is genuinely open, stillness means idle — but a
        // mascot that visibly works is a much better answer to "is this thing alive?" than an arc.
        _mascotMotion.Children.Add(_breathe);
        _mascotMotion.Children.Add(_tilt);
        _mascotMotion.Children.Add(_bob);
        _mascot = new Image
        {
            Width = 44, Height = 44, IsVisible = false,
            RenderTransform = _mascotMotion,
            RenderTransformOrigin = RelativePoint.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        try { _mascot.Source = new Bitmap(AssetLoader.Open(new Uri("avares://Kitten.Desktop/Assets/kitten-256.png"))); }
        catch { /* no artwork: the ring below still carries the state */ }

        _headline = new TextBlock { Text = "Idle", FontSize = 12.5, Foreground = Muted, VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
        _meta = new TextBlock { Text = "", FontSize = 11, Foreground = Faint, VerticalAlignment = VerticalAlignment.Center };
        _workers = new StackPanel { Spacing = 2, Margin = new Thickness(0, 8, 0, 0) };

        var head = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto"), ColumnSpacing = 8 };
        head.Children.Add(_ring);
        var headlineHost = _headline;
        Grid.SetColumn(headlineHost, 1);
        head.Children.Add(headlineHost);
        Grid.SetColumn(_meta, 2);
        head.Children.Add(_meta);

        Root = new StackPanel { Spacing = 0, Children = { head, _workers } };
        // The mascot is hosted separately, beside the composer. The ring stays here as the side-pane
        // indicator, so the panel still shows liveness on its own.
        Mascot = new Panel { Width = 44, Height = 44, Children = { _mascot } };
        _ticker.Tick += (_, _) => Tick();
    }

    /// <summary>The configured pair, so a worker row can name the model actually doing the work.</summary>
    public void SetModels(string main, string sidecar)
    {
        _mainModel = main ?? "";
        _sidecarModel = sidecar ?? "";
    }

    // ── Run lifecycle ───────────────────────────────────────────────────────────────────────────

    public void RunStarted()
    {
        _running = true;
        _startedAt = DateTimeOffset.UtcNow;
        _tools = 0;
        _subagents = 0;
        _candidates = 0;
        _headline.Text = "Working";
        _headline.Foreground = TextBrush;
        // They now live in different places, so both show: the ring labels the panel, the mascot sits
        // by the composer where the user is actually looking.
        _mascot.IsVisible = _mascot.Source is not null;
        _ring.IsVisible = true;
        _ticker.Start();
        Working("starting");
    }

    public void RunEnded(string outcome)
    {
        _running = false;
        _ticker.Stop();
        _ring.IsVisible = false;
        RestMascot();
        _headline.Text = outcome;
        _headline.Foreground = Muted;
        foreach (var worker in _byKey.Values.ToList()) Finish(worker.Key, null);
        UpdateMeta();
    }

    public void Reset()
    {
        _running = false;
        _ticker.Stop();
        _ring.IsVisible = false;
        RestMascot();
        _headline.Text = "Idle";
        _headline.Foreground = Muted;
        _meta.Text = "";
        _workers.Children.Clear();
        _byKey.Clear();
        _tools = 0;
        _subagents = 0;
        _candidates = 0;
    }

    /// <summary>What the MAIN model is doing right now, in its own words rather than a category.</summary>
    public void Working(string what)
    {
        if (!_running) return;
        Upsert(MainKey, string.IsNullOrWhiteSpace(_mainModel) ? "main model" : _mainModel, what, Accent);
    }

    public void ToolStarted(string name, string target)
    {
        _tools++;
        var detail = string.IsNullOrWhiteSpace(target) ? name : $"{name} {Clip(target, 46)}";
        Working(detail);
        UpdateMeta();
    }

    // ── The other workers ───────────────────────────────────────────────────────────────────────

    /// <summary>The clerical model. It runs on the CPU in parallel with the main model, and none of
    /// that was ever visible — so the app looked idle while two models were busy.</summary>
    public void SidecarWorking(string what) =>
        Upsert(SidecarKey, string.IsNullOrWhiteSpace(_sidecarModel) ? "sidecar" : _sidecarModel, what, Ok);

    public void SidecarDone(string? summary) => Finish(SidecarKey, summary);

    /// <summary>
    /// A subagent with its own conversation, its own model tier and its own objective. One line of
    /// "Subagent started" told you none of that — which agent, working on what, or whether the answer
    /// it eventually produced was any good.
    /// </summary>
    public void SubagentStarted(string id, string agent, string objective)
    {
        _subagents++;
        var worker = Upsert($"task:{id}", string.IsNullOrWhiteSpace(agent) ? "subagent" : agent, "working", Accent);
        SetNote(worker, Clip(FirstSentence(objective), 150), Faint);
        UpdateMeta();
    }

    public void SubagentFinished(string id, string status, string summary, int promptTokens, int completionTokens)
    {
        var key = $"task:{id}";
        if (!_byKey.TryGetValue(key, out var worker)) return;
        var failed = status is "failed" or "cancelled" or "blocked";
        worker.Dot.Fill = failed ? Err : Ok;
        var seconds = (int)(DateTimeOffset.UtcNow - worker.StartedAt).TotalSeconds;
        var tokens = promptTokens + completionTokens > 0 ? $" · {promptTokens + completionTokens:n0} tokens" : "";
        worker.Detail.Text = $"{status}{(seconds > 0 ? $" in {seconds}s" : "")}{tokens}";
        worker.Detail.Foreground = failed ? Err : Ok;
        worker.Elapsed.Text = "";
        worker.Active = false;
        // What it CONCLUDED is the point of having run it, so the objective gives way to the answer.
        SetNote(worker, Clip(string.IsNullOrWhiteSpace(summary) ? "no summary reported" : summary, 220), Muted);
        UpdateMeta();
    }

    // ── Ascent candidates ───────────────────────────────────────────────────────────────────────
    //
    // On the ascent lane the run IS k parallel candidates in isolated workspaces, one of which gets
    // adopted. None of that was visible: the panel showed a single "main model — starting" row for the
    // whole generation phase, which on a local 35B is many minutes. A row each, with the one being
    // streamed marked, is the difference between a black box and a progress report.

    public void CandidateStarted(int index, bool lead)
    {
        _candidates++;
        var worker = Upsert($"cand:{index}", $"candidate {index}", lead ? "generating · streaming below" : "generating", Accent);
        if (lead) worker.Name.Foreground = Accent;
        UpdateMeta();
    }

    public void CandidateFinished(int index, bool finished, string summary)
    {
        if (!_byKey.TryGetValue($"cand:{index}", out var worker)) return;
        var seconds = (int)(DateTimeOffset.UtcNow - worker.StartedAt).TotalSeconds;
        worker.Detail.Text = finished ? $"finished in {seconds}s" : $"gave up after {seconds}s";
        worker.Detail.Foreground = finished ? Ok : Muted;
        worker.Dot.Fill = finished ? Ok : Faint;
        worker.Elapsed.Text = "";
        worker.Active = false;
        SetNote(worker, Clip(summary, 160), Faint);
        UpdateMeta();
    }

    public void CandidateRejected(int index, string reason)
    {
        if (!_byKey.TryGetValue($"cand:{index}", out var worker)) return;
        worker.Detail.Text = "rejected";
        worker.Detail.Foreground = Err;
        worker.Dot.Fill = Err;
        worker.Elapsed.Text = "";
        worker.Active = false;
        // WHY it lost is the useful part — "rejected" alone teaches nothing about the run.
        SetNote(worker, Clip(reason, 200), Muted);
        UpdateMeta();
    }

    /// <summary>An objective is often a paragraph; the first sentence is the part that identifies it.</summary>
    private static string FirstSentence(string text)
    {
        var one = (text ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        var stop = one.IndexOf(". ", StringComparison.Ordinal);
        return stop > 20 ? one[..(stop + 1)] : one;
    }

    private Worker Upsert(string key, string name, string detail, IBrush colour)
    {
        if (!_byKey.TryGetValue(key, out var worker))
        {
            var dot = new Ellipse { Width = 6, Height = 6, Fill = colour, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 5, 0, 0) };
            var nameBlock = new TextBlock { Text = name, FontSize = 11.5, Foreground = TextBrush, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 130 };
            var detailBlock = new TextBlock { Text = detail, FontSize = 11.5, Foreground = Muted, TextTrimming = TextTrimming.CharacterEllipsis };
            var elapsed = new TextBlock { Text = "", FontSize = 10.5, Foreground = Faint, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(0, 1, 0, 0) };
            var body = new StackPanel { Spacing = 1 };
            var top = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 7 };
            top.Children.Add(nameBlock);
            top.Children.Add(detailBlock);
            body.Children.Add(top);
            var grid = new Grid { ColumnDefinitions = new ColumnDefinitions("Auto,*,Auto"), ColumnSpacing = 7 };
            grid.Children.Add(dot);
            Grid.SetColumn(body, 1); grid.Children.Add(body);
            Grid.SetColumn(elapsed, 2); grid.Children.Add(elapsed);
            var row = new Border { Padding = new Thickness(0, 3), Child = grid };
            worker = new Worker { Key = key, Row = row, Dot = dot, Name = nameBlock, Detail = detailBlock, Elapsed = elapsed, Body = body };
            _byKey[key] = worker;
            _workers.Children.Add(row);
        }
        worker.Detail.Text = detail;
        worker.Detail.Foreground = Muted;
        worker.Dot.Fill = colour;
        worker.Active = true;
        worker.StartedAt = DateTimeOffset.UtcNow;
        return worker;
    }

    /// <summary>The second line of a worker row — the objective, or the result it reported.</summary>
    private static void SetNote(Worker worker, string text, IBrush colour)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        if (worker.Note is null)
        {
            worker.Note = new TextBlock { FontSize = 10.5, Foreground = Faint, TextWrapping = TextWrapping.Wrap, MaxLines = 3 };
            worker.Body.Children.Add(worker.Note);
        }
        worker.Note.Text = text;
        worker.Note.Foreground = colour;
    }

    private void Finish(string key, string? detail)
    {
        if (!_byKey.TryGetValue(key, out var worker)) return;
        // A worker that already reported its own outcome keeps it. Without this, the end-of-run sweep
        // repaints a REJECTED candidate green and overwrites the reason it lost.
        if (!worker.Active) return;
        worker.Active = false;
        worker.Elapsed.Text = "";
        if (key == MainKey || key == SidecarKey)
        {
            // The transient workers disappear when idle. Leaving "main model — thinking" on screen
            // after a run ended is the kind of stale detail that teaches people to distrust the panel.
            _workers.Children.Remove(worker.Row);
            _byKey.Remove(key);
            return;
        }
        if (!string.IsNullOrWhiteSpace(detail)) worker.Detail.Text = Clip(detail!, 60);
        worker.Dot.Fill = Ok;
    }

    /// <summary>Settle the mascot back to a neutral pose so a finished run does not freeze mid-bounce.</summary>
    private void RestMascot()
    {
        _mascot.IsVisible = false;
        _tilt.Angle = 0;
        _bob.Y = 0;
        _breathe.ScaleX = _breathe.ScaleY = 1;
    }

    private void Tick()
    {
        // ~16 fps: fast enough to read as motion, slow enough to be free.
        _spin.Angle = (_spin.Angle + 9) % 360;
        // A bob, a tilt against it, and a slow breath. Three cheap sines out of phase read as a living
        // thing; a single rotation reads as a loading spinner wearing a cat costume.
        _phase += 0.16;
        _bob.Y = Math.Sin(_phase) * 2.1;
        _tilt.Angle = Math.Sin(_phase * 0.5) * 7;
        var breath = 1 + Math.Sin(_phase * 0.37) * 0.045;
        _breathe.ScaleX = _breathe.ScaleY = breath;
        UpdateMeta();
        foreach (var worker in _byKey.Values)
        {
            if (!worker.Active) continue;
            var seconds = (int)(DateTimeOffset.UtcNow - worker.StartedAt).TotalSeconds;
            worker.Elapsed.Text = seconds >= 1 ? $"{seconds}s" : "";
        }
    }

    private void UpdateMeta()
    {
        if (!_running) { _meta.Text = ""; return; }
        var elapsed = DateTimeOffset.UtcNow - _startedAt;
        var time = elapsed.TotalMinutes >= 1 ? $"{(int)elapsed.TotalMinutes}m {elapsed.Seconds:00}s" : $"{elapsed.Seconds}s";
        var parts = new List<string>();
        if (_candidates > 0) parts.Add($"{_candidates} candidate{(_candidates == 1 ? "" : "s")}");
        if (_subagents > 0) parts.Add($"{_subagents} subagent{(_subagents == 1 ? "" : "s")}");
        if (_tools > 0) parts.Add($"{_tools} tool{(_tools == 1 ? "" : "s")}");
        parts.Add(time);
        _meta.Text = string.Join(" · ", parts);
    }

    private static string Clip(string value, int max)
    {
        var one = (value ?? "").Replace('\r', ' ').Replace('\n', ' ').Trim();
        return one.Length > max ? one[..(max - 1)] + "…" : one;
    }
}
