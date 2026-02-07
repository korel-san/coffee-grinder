#SingleInstance, Force
SendMode Input
SetWorkingDir, %A_ScriptDir%

#Include C:\Program Files\AutoHotkey\Gdip_All.ahk ;added library must be added
Global clipType

global NewsIndex := []
global NewsLinks := []


readFile() ;make a list of names index and links
prepareScreen()
runBrowserLinks() ;start 
endscenario()


endscenario()
{
    IfWinExist, ahk_exe opera.exe
    WinMinimize, A
    sleep 1500
    send ^!{Down}

    ;MsgBox, Script Done its job. `nPress OK and check results
    ExitApp
    return
}

prepareScreen()
{
    send ^!{Left}
    IfWinExist, ahk_exe opera.exe
    WinActivate  ; Bring Opera to the front
    Sleep, 500  ; Wait for the window to become active
    Send, {F11}  ; Send the F11 key to enter full-screen mode
    sleep 5000
    return
}

runBrowserLinks()
{
    Loop, % NewsIndex.Length()
    {
        operateLink(A_Index)
        SoundBeep, 500, 100
        SoundBeep, 600, 200
        Sleep, 500
    }

    Soundbeep, 523, 150
    Soundbeep, 600, 150
    Soundbeep, 650, 150
    Soundbeep, 760, 300
}

readFile()
{
    NewsTemp :=[]
    Loop, read, screenshots.txt  ; Read each line from screenshots.txt
        {
            NewsTemp.Push(A_LoopReadLine)
            ; A_Index contains the current line number
            ;MsgBox, Line %A_Index%: %A_LoopReadLine%  ; Display the content of each line (optional)
            
            ; Your code to process each line goes here
            ; Example: Run, %A_LoopReadLine%  ; Execute each line as a command (if lines are commands)
        
            ; Replace the comment with your actual processing logic
            ; Example: Send, %A_LoopReadLine%  ; Sends each line as keystrokes (if lines are text)
        }

    Loop, % NewsTemp.Length()
    {
        If (NewsLinks[NewsLinks.Length()] == NewsTemp[A_Index])
            {
                Continue
            }

        NewsIndex.Push(NewsTemp[A_Index])
        NewsLinks.Push(NewsTemp[A_Index+1])
    }

        return
}

operateLink(Index)
{
    Run, % NewsLinks[Index]
    Sleep, 5000
    Send, {Esc}
    Sleep, 250
    Send, {Esc}
    Sleep, 250
    Send, {Esc}
    Sleep, 250
    PrintScreen(Index)
    Sleep, 500
    IfWinExist, ahk_exe opera.exe
    {
        WinActivate
        Sleep, 300
        Send, ^{F4}
        Sleep, 500
    }

    return
}

CheckIfMaximized()
{
    WinGetPos, X, Y, Width, Height, A  ; Get active window position and size
    SysGet, ScreenWidth, 78  ; Get screen width
    SysGet, ScreenHeight, 79  ; Get screen height

    if (X = 0 && Y = 0 && Width = ScreenWidth && Height = ScreenHeight)
        MsgBox, The active window is in fullscreen mode!
    else
    {
        Send {F11}
        sleep 5000
    }
    return
}

PrintScreen(index) ; PrintScreen = Save clipboard image to file
{
    Send, {AltDown}
    Sleep, 100
    Send, {PrintScreen}
    ClipWait, ,1
    Sleep, 100
    Send, {AltUp}
    Sleep, 100
    Send, {Esc}
    Sleep, 500
    ;FormatTime, CDT,, yyyy_MM_dd_HH-mm

    filePath := A_ScriptDir "\" NewsIndex[index] ".jpg"
    clipboardToImageFile(filePath)
    Sleep, 2000
    Clipboard :=""

    Return
}

clipboardToImageFile(filePath) {
 pToken  := Gdip_Startup()
 pBitmap := Gdip_CreateBitmapFromClipboard() ; Clipboard -> bitmap
 Gdip_SaveBitmapToFile(pBitmap, filePath)    ; Bitmap    -> file
 Gdip_DisposeImage(pBitmap), Gdip_Shutdown(pToken)
}

!x:: ExitApp