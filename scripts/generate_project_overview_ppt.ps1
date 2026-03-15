$ErrorActionPreference = "Stop"

$outputPath = Join-Path $PSScriptRoot "..\\docs\\Acuity-Engine-Project-Overview.pptx"
$outputPath = [System.IO.Path]::GetFullPath($outputPath)

$ppLayoutTitle = 1
$ppLayoutText = 2
$ppSaveAsOpenXMLPresentation = 24
$msoTrue = -1

function Set-TextFrame($shape, $title, $lines) {
  $textRange = $shape.TextFrame.TextRange
  $textRange.Text = $title
  $textRange.Font.Name = "Aptos"
  $textRange.Font.Size = 26
  $textRange.Font.Bold = $msoTrue

  if ($lines.Count -gt 0) {
    $textRange.InsertAfter("`r`n")
    foreach ($line in $lines) {
      $textRange.InsertAfter($line + "`r`n")
    }
  }

  for ($i = 2; $i -le $textRange.Paragraphs().Count; $i++) {
    $p = $textRange.Paragraphs($i)
    $p.ParagraphFormat.Bullet.Visible = $msoTrue
    $p.Font.Name = "Aptos"
    $p.Font.Size = 20
    $p.Font.Bold = 0
  }
}

$slides = @(
  @{
    Title = "Acuity Engine Overview"
    Subtitle = "A healthcare operations platform for building safer, fairer, more visible assignments"
  },
  @{
    Title = "What Problem It Solves"
    Bullets = @(
      "Charge nurses still often build assignments on paper or in Excel under constant interruption.",
      "That process depends on memory, manual mental math, and inconsistent rule-checking.",
      "The result can be uneven workload, hidden acuity stacking, excess handoffs, and preventable assignment drift."
    )
  },
  @{
    Title = "What The Platform Does"
    Bullets = @(
      "Captures staffing, patient details, acuity tags, discharge expectations, and continuity locks in one place.",
      "Builds live and oncoming assignments from that structured information.",
      "Uses a balancing engine to improve safety, fairness, continuity, room clustering, and handoff quality."
    )
  },
  @{
    Title = "How The Tabs Work Together"
    Bullets = @(
      "Staffing Details defines who is available.",
      "Patient Details captures the workload drivers.",
      "Live Assignments supports current-shift operations.",
      "Oncoming Assignments prepares the next shift with rebalancing.",
      "Hand-off, Pulse, and Metrics add reporting, surveillance, and retrospective insight."
    )
  },
  @{
    Title = "Why It Is Better Than Paper Or Excel"
    Bullets = @(
      "Paper and spreadsheets document assignments, but they do not actively optimize them.",
      "The platform checks explicit rules repeatedly and consistently.",
      "It gives the whole team a shared live view instead of separate static copies.",
      "It can regenerate a better board when staffing or patient conditions change."
    )
  },
  @{
    Title = "How The Assignment Engine Thinks"
    Bullets = @(
      "Priority order: safe assignments first, balanced patient counts second, balanced acuity-load third.",
      "After that it reduces report sources and tightens room spread.",
      "The newer engine versions search multiple candidate boards instead of relying only on one-pass local fixes."
    )
  },
  @{
    Title = "Operational Value For End Users"
    Bullets = @(
      "Reduces hidden mental workload for the charge nurse.",
      "Makes acuity and handoff tradeoffs more visible before finalizing assignments.",
      "Improves consistency when multiple people touch the assignment process across a shift change.",
      "Creates a clearer, more defensible assignment rationale."
    )
  },
  @{
    Title = "Why This Matters In Healthcare"
    Bullets = @(
      "More consistent balancing can reduce preventable workload concentration.",
      "Better shared visibility can reduce confusion and assignment drift.",
      "Structured handoff support can reduce omission risk during report.",
      "The system does not replace judgment; it strengthens judgment with better operational intelligence."
    )
  },
  @{
    Title = "Project Direction"
    Bullets = @(
      "The product is moving from a formatting tool toward a true optimization platform.",
      "Current focus: stronger multi-move balancing, better acuity fairness, fewer handoffs, and tighter room clustering.",
      "Longer term: clearer explanations, historical learning, and more predictive operational support."
    )
  }
)

$pp = $null
$presentation = $null

try {
  $pp = New-Object -ComObject PowerPoint.Application
  $pp.Visible = $msoTrue
  $presentation = $pp.Presentations.Add()

  while ($presentation.Slides.Count -gt 0) {
    $presentation.Slides.Item(1).Delete()
  }

  for ($i = 0; $i -lt $slides.Count; $i++) {
    $slideDef = $slides[$i]
    if ($i -eq 0) {
      $slide = $presentation.Slides.Add($presentation.Slides.Count + 1, $ppLayoutTitle)
      $slide.Shapes.Title.TextFrame.TextRange.Text = $slideDef.Title
      $slide.Shapes.Item(2).TextFrame.TextRange.Text = $slideDef.Subtitle
      $slide.Shapes.Title.TextFrame.TextRange.Font.Name = "Aptos Display"
      $slide.Shapes.Title.TextFrame.TextRange.Font.Size = 28
      $slide.Shapes.Item(2).TextFrame.TextRange.Font.Name = "Aptos"
      $slide.Shapes.Item(2).TextFrame.TextRange.Font.Size = 20
    } else {
      $slide = $presentation.Slides.Add($presentation.Slides.Count + 1, $ppLayoutText)
      $slide.Shapes.Title.TextFrame.TextRange.Text = $slideDef.Title
      $slide.Shapes.Title.TextFrame.TextRange.Font.Name = "Aptos Display"
      $slide.Shapes.Title.TextFrame.TextRange.Font.Size = 28
      Set-TextFrame -shape $slide.Shapes.Item(2) -title "" -lines $slideDef.Bullets
    }

    $slide.FollowMasterBackground = $msoTrue
  }

  if (Test-Path $outputPath) {
    Remove-Item $outputPath -Force
  }
  $presentation.SaveAs($outputPath, $ppSaveAsOpenXMLPresentation)
  Write-Output "Saved: $outputPath"
}
finally {
  if ($presentation) { $presentation.Close() }
  if ($pp) { $pp.Quit() }
}
