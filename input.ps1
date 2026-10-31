# Lee comandos por stdin (uno por línea) y los inyecta como mouse/teclado reales.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class In {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [StructLayout(LayoutKind.Sequential)] struct KI { public ushort vk, sc; public uint f, t; public IntPtr e; }
  [StructLayout(LayoutKind.Explicit, Size = 40)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KI ki; }

  public static void Move(double x, double y) { SetCursorPos((int)(x * GetSystemMetrics(0)), (int)(y * GetSystemMetrics(1))); }
  public static void Click(uint down, uint up) { mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero); }
  public static void Wheel(int d) { mouse_event(0x800, 0, 0, d, UIntPtr.Zero); }
  public static void Key(byte vk) {
    uint ext = (vk >= 0x21 && vk <= 0x2E) ? 1u : 0u; // flechas, Inicio, Fin, etc. son teclas extendidas
    keybd_event(vk, 0, ext, UIntPtr.Zero); keybd_event(vk, 0, ext | 2, UIntPtr.Zero);
  }
  public static void Text(string s) { foreach (char c in s) { Uni(c, 4); Uni(c, 6); } }
  static void Uni(char c, uint f) { var i = new INPUT[1]; i[0].type = 1; i[0].ki.sc = c; i[0].ki.f = f; SendInput(1, i, 40); }
}
'@
[In]::SetProcessDPIAware() | Out-Null # coordenadas en píxeles reales, igual que la captura
# Sin esto Windows suspende o bloquea el PC a mitad de un capítulo y la captura queda en negro.
[In]::SetThreadExecutionState([uint32]2147483651) | Out-Null # 0x80000003 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED (PS 5.1 lee 0x8... como negativo)

while ($null -ne ($l = [Console]::In.ReadLine())) {
  $p = $l.Split(' ')
  try {
    switch ($p[0]) {
      'click'  { [In]::Move([double]$p[1], [double]$p[2]); [In]::Click(2, 4) }
      'rclick' { [In]::Move([double]$p[1], [double]$p[2]); [In]::Click(8, 16) }
      'wheel'  { [In]::Wheel([int]$p[1]) }
      'key'    { [In]::Key([byte][int]$p[1]) }
      'text'   { [In]::Text([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1]))) }
    }
  } catch { [Console]::Error.WriteLine($_) }
}
