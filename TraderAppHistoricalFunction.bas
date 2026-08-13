Attribute VB_Name = "TraderAppHistoricalFunction"
Option Explicit

Public Function TraderAppHistorical(ByVal Symbol As String, ByVal Interval As String, ByVal FromDate As String, ByVal ToDate As String, Optional ByVal EnableTA As Boolean = True) As Variant
    ' Returns a 2D array of candle data from TraderApp public API.
    ' The endpoint returns pipe-delimited text, not JSON.
    ' Example:
    ' =TraderAppHistorical("RELIANCE","15","2026-07-01","2026-07-13",TRUE)

    Dim Url As String
    Dim Http As Object
    Dim ResponseText As String
    Dim Lines() As String
    Dim RowData() As String
    Dim HeaderRow As String
    Dim Result() As Variant
    Dim i As Long, j As Long
    Dim RowCount As Long
    Dim ColCount As Long
    Dim BaseUrl As String
    Dim TAParam As String

    On Error GoTo ErrHandler

    BaseUrl = "http://127.0.0.1:5000/public/api/5paisa/historical"
    TAParam = IIf(EnableTA, "true", "false")

    Url = BaseUrl & "?symbol=" & EncodeUrl(Symbol) & "&interval=" & EncodeUrl(Interval) & _
          "&from=" & EncodeUrl(FromDate) & "&to=" & EncodeUrl(ToDate) & "&TA=" & TAParam & "&v=2"

    Set Http = CreateObject("MSXML2.XMLHTTP")
    Http.Open "GET", Url, False
    Http.send

    If Http.Status <> 200 Then
        TraderAppHistorical = "Error: HTTP " & Http.Status
        Exit Function
    End If

    ResponseText = Http.responseText
    If Trim$(ResponseText) = "" Then
        TraderAppHistorical = "Error: empty response"
        Exit Function
    End If

    Lines = Split(ResponseText, vbCrLf)
    If UBound(Lines) < 0 Then
        TraderAppHistorical = "Error: no data rows"
        Exit Function
    End If

    HeaderRow = Trim$(Lines(0))
    If Len(HeaderRow) = 0 Then
        TraderAppHistorical = "Error: missing header row"
        Exit Function
    End If

    RowData = Split(HeaderRow, "|")
    ColCount = UBound(RowData) - LBound(RowData) + 1
    RowCount = UBound(Lines) - LBound(Lines) + 1

    ReDim Result(0 To RowCount - 1, 0 To ColCount - 1)

    For j = 0 To ColCount - 1
        Result(0, j) = Trim$(RowData(j))
    Next j

    For i = 1 To UBound(Lines)
        If Trim$(Lines(i)) <> "" Then
            RowData = Split(Lines(i), "|")
            For j = 0 To UBound(RowData)
                If j < ColCount Then
                    Result(i, j) = Trim$(RowData(j))
                End If
            Next j
        End If
    Next i

    TraderAppHistorical = Result
    Exit Function

ErrHandler:
    TraderAppHistorical = "Error: " & Err.Description
End Function

Private Function EncodeUrl(ByVal Value As String) As String
    EncodeUrl = Replace(Value, " ", "%20")
    EncodeUrl = Replace(EncodeUrl, "&", "%26")
    EncodeUrl = Replace(EncodeUrl, "?", "%3F")
End Function
