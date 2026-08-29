using Avalonia.Controls;
using Avalonia.Media;
using Avalonia.Threading;

namespace Kitten.Desktop;

/// <summary>
/// The live "what is Kitten doing" surface at the top of the right pane: the route it chose (with
/// hardness + effort), the compiled plan and its steps, the tool it is running right now, and the
/// verification evidence as it lands. Fed exclusively by engine events — this class renders state,
/// it never invents it.
/// </summary>
public sealed class ActivityPanel
{
    private readonly TextBlock _runMeta;
    private readonly TextBlock _routeLine;
    private readonly Border _planCard;
    private readonly TextBlock _planGoal;
    private readonly TextBlock _planContract;
    private readonly StackPanel _planSteps;
    private readonly Button _planDetailButton;
    private readonly TextBlock _currentToolLine;
    private readonly TextBlock _verificationLine;

    private readonly Dictionary<string, (TextBlock Mark, TextBlock Label)> _stepRows = new(StringComparer.Ordinal);
    private readonly DispatcherTimer _elapsedTimer;
    private DateTimeOffset _runStartedAt;
    private bool _running;
    private int _toolCalls;
    private int _checksPassed;
    private int _checksTotal;

    private static readonly IBrush Muted = new SolidColorBrush(Color.Parse("#9a9aa4"));
    private static readonly IBrush TextBrush = new SolidColorBrush(Color.Parse("#e8e8ec"));
    private static readonly IBrush Ok = new SolidColorBrush(Color.Parse("#6ee7a8"));
    private static readonly IBrush Err = new SolidColorBrush(Color.Parse("#f4837f"));
    private static readonly IBrush Accent = new SolidColorBrush(Color.Parse("#e0a15c"));
    private static readonly IBrush Faint = new SolidColorBrush(Color.Parse("#6a6a74"));

    public ActivityPanel(TextBlock runMeta, TextBlock routeLine, Border planCard, TextBlock planGoal, TextBlock planContract, StackPanel planSteps, Button planDetailButton, TextBlock currentToolLine, TextBlock verificationLine)
    {
        _runMeta = runMeta;
        _routeLine = routeLine;
        _planCard = planCard;
        _planGoal = planGoal;
        _planContract = planContract;
        _planSteps = planSteps;
        _planDetailButton = planDetailButton;
        _currentToolLine = currentToolLine;
        _verificationLine = verificationLine;
        _elapsedTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        _elapsedTimer.Tick += (_, _) => UpdateMeta();
    }

    /// <summary>The runId of the compiled contract shown in the plan card, for the detail dialog.</summary>
    public string? CompiledRunId { get; private set; }

    public void RunStarted()
    {
        _running = true;
        _runStartedAt = DateTimeOffset.UtcNow;
        _toolCalls = 0;
        _checksPassed = 0;
        _checksTotal = 0;
        _verificationLine.IsVisible = false;
        _currentToolLine.IsVisible = false;
        UpdateMeta();
        _elapsedTimer.Start();
    }

    public void RunEnded()
    {
        _running = false;
        _elapsedTimer.Stop();
        _currentToolLine.IsVisible = false;
        UpdateMeta();
    }

    /// <summary>A fresh conversation: clear everything the previous session's run left behind.</summary>
    public void Reset()
    {
        RunEnded();
        _runMeta.Text = "";
        _routeLine.IsVisible = false;
        _planCard.IsVisible = false;
        _planSteps.Children.Clear();
        _stepRows.Clear();
        _planDetailButton.IsVisible = false;
        _verificationLine.IsVisible = false;
        CompiledRunId = null;
    }

    public void SetRoute(string lane, int k, double? hardness, string? effort)
    {
        var parts = new List<string> { $"route: {lane}" };
        if (k > 1) parts.Add($"k={k}");
        if (hardness is not null) parts.Add($"hardness {hardness.Value:0.#}");
        if (!string.IsNullOrWhiteSpace(effort)) parts.Add(effort!);
        _routeLine.Text = string.Join(" · ", parts);
        _routeLine.IsVisible = true;
    }

    public void SetCompiled(string runId, string goal, string contractLine)
    {
        CompiledRunId = runId;
        _planGoal.Text = goal;
        _planContract.Text = contractLine;
        _planCard.IsVisible = true;
        _planDetailButton.IsVisible = true;
    }

    /// <summary>Replace (never append) the step list — plan.updated is a snapshot.</summary>
    public void SetPlanSteps(IReadOnlyList<(string Id, string Label, string Status)> steps)
    {
        _planSteps.Children.Clear();
        _stepRows.Clear();
        foreach (var (id, label, status) in steps)
        {
            var mark = new TextBlock { Text = MarkFor(status), Foreground = BrushFor(status), FontSize = 11.5, Width = 14 };
            var text = new TextBlock { Text = label, Foreground = status == "running" ? TextBrush : Muted, FontSize = 11.5, TextTrimming = TextTrimming.CharacterEllipsis };
            var row = new StackPanel { Orientation = Avalonia.Layout.Orientation.Horizontal, Spacing = 4 };
            row.Children.Add(mark);
            row.Children.Add(text);
            _planSteps.Children.Add(row);
            _stepRows[id] = (mark, text);
        }
        _planCard.IsVisible = _planSteps.Children.Count > 0 || !string.IsNullOrWhiteSpace(_planGoal.Text);
    }

    public void StepChanged(string stepId, string status)
    {
        if (!_stepRows.TryGetValue(stepId, out var row)) return;
        row.Mark.Text = MarkFor(status);
        row.Mark.Foreground = BrushFor(status);
        row.Label.Foreground = status == "running" ? TextBrush : Muted;
        row.Label.FontWeight = status == "running" ? FontWeight.SemiBold : FontWeight.Normal;
    }

    public void ToolStarted(string name, string target)
    {
        _toolCalls++;
        var line = string.IsNullOrWhiteSpace(target) ? name : $"{name} {target}";
        _currentToolLine.Text = $"running: {line}";
        _currentToolLine.IsVisible = true;
        UpdateMeta();
    }

    public void ToolFinished()
    {
        _currentToolLine.IsVisible = false;
    }

    public void VerificationStarted(string what)
    {
        _checksPassed = 0;
        _checksTotal = 0;
        _verificationLine.Text = $"verifying — {what}";
        _verificationLine.Foreground = Muted;
        _verificationLine.IsVisible = true;
    }

    public void VerificationEvidence(string check, bool passed, long durationMs)
    {
        _checksTotal++;
        if (passed) _checksPassed++;
        var duration = durationMs >= 1000 ? $"{durationMs / 1000.0:0.0}s" : $"{durationMs}ms";
        _verificationLine.Text = $"verifying · {_checksPassed}/{_checksTotal} checks · {(passed ? "✓" : "✗")} {check} ({duration})";
        _verificationLine.Foreground = Muted;
        _verificationLine.IsVisible = true;
    }

    public void VerificationPassed(string detail)
    {
        _verificationLine.Text = $"✓ {detail}";
        _verificationLine.Foreground = Ok;
        _verificationLine.IsVisible = true;
    }

    public void VerificationFailed(string detail)
    {
        _verificationLine.Text = $"✗ {detail}";
        _verificationLine.Foreground = Err;
        _verificationLine.IsVisible = true;
    }

    public void RepairStarted(int round, string seed)
    {
        _verificationLine.Text = $"repairing (round {round}) — {Clip(seed, 140)}";
        _verificationLine.Foreground = Accent;
        _verificationLine.IsVisible = true;
    }

    private void UpdateMeta()
    {
        if (!_running && _toolCalls == 0) { _runMeta.Text = ""; return; }
        var elapsed = DateTimeOffset.UtcNow - _runStartedAt;
        var time = elapsed.TotalHours >= 1 ? $"{(int)elapsed.TotalHours}h {elapsed.Minutes}m" : elapsed.TotalMinutes >= 1 ? $"{(int)elapsed.TotalMinutes}m {elapsed.Seconds}s" : $"{elapsed.Seconds}s";
        _runMeta.Text = _running ? (_toolCalls > 0 ? $"{_toolCalls} tool{(_toolCalls == 1 ? "" : "s")} · {time}" : time) : "";
        _runMeta.Foreground = Faint;
    }

    private static string MarkFor(string status) => status switch
    {
        "running" => "▶",
        "completed" => "✓",
        "failed" => "✗",
        "blocked" or "cancelled" => "⊘",
        "waiting" => "~",
        _ => "·",
    };

    private static IBrush BrushFor(string status) => status switch
    {
        "running" => Accent,
        "completed" => Ok,
        "failed" => Err,
        "blocked" or "cancelled" => Err,
        _ => Faint,
    };

    private static string Clip(string value, int max)
    {
        var one = value.Replace("\r", " ").Replace("\n", " ").Trim();
        return one.Length > max ? one[..(max - 1)] + "…" : one;
    }
}
