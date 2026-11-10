/**
 * Comillado POSIX para armar líneas de comando remotas (ARCHITECTURE §3.15: "nunca por shell").
 * `ssh host cmd` concatena sus argumentos con espacios y el shell remoto los vuelve a parsear, así
 * que este es el ÚNICO sitio donde omni arma una línea de shell: cada parte pasa por `shq`, nunca se
 * pega texto a mano.
 */

/**
 * Comillas simples POSIX: `'…'` con cada `'` interno como `'\''`. Dentro de comillas simples el
 * shell no interpreta nada (`$`, backticks, `\`, saltos de línea), así que cualquier string llega
 * literal. El string vacío queda `''` (un argumento vacío, no "ningún argumento").
 */
export function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/**
 * Línea `exec 'cmd' 'arg'…` (con `cd -- '<cwd>' &&` delante si hay `cwd`). `exec` reemplaza al
 * shell remoto por el proceso: el código de salida y las señales son los del comando, sin un shell
 * intermedio. `args[0]` es el ejecutable; no puede faltar.
 */
export function shCommand(args: string[], cwd?: string): string {
  if (args.length === 0) throw new Error('shCommand: falta el ejecutable')
  const line = `exec ${args.map(shq).join(' ')}`
  return cwd === undefined ? line : `cd -- ${shq(cwd)} && ${line}`
}

/**
 * Corre `cmdline` (POSIX) con el entorno del shell de login del usuario, que es donde viven el PATH
 * de nvm/asdf/brew. El shell de login solo hace de "cargador de perfil": la línea viaja en la
 * variable `OMNI_LINE` y la ejecuta `/bin/sh`, así un fish o un csh nunca parsean sintaxis POSIX.
 * csh/tcsh no aceptan `-lc` (solo `-l` a secas): ahí va `-c` y su PATH sale de `.cshrc`. Sin
 * `$SHELL`, `/bin/sh`. Se evalúa en `/bin/sh` (ver `remoteLine`).
 */
export function loginWrap(cmdline: string): string {
  const inner = shq(`exec /bin/sh -c 'l=$OMNI_LINE; unset OMNI_LINE; eval "$l"'`)
  return `OMNI_LINE=${shq(cmdline)}; export OMNI_LINE; case "\${SHELL##*/}" in csh|tcsh) f=-c ;; *) f=-lc ;; esac; exec "\${SHELL:-/bin/sh}" "$f" ${inner}`
}

/** Bytes que cualquier shell de login (sh, bash, zsh, fish, csh/tcsh) deja literales entre comillas simples. */
const PLAIN_LINE = /^[\x20-\x7e]*$/
/** Bytes que viajan tal cual dentro del formato de `printf` (sin `%`, `\` ni `-`, que podría leerse como opción); el resto va como `\ooo`. */
const PRINTF_LITERAL = /[A-Za-z0-9 ,._+:@=/]/

/**
 * Línea que se le entrega a sshd. sshd la pasa al shell de login del usuario (`$SHELL -c`), que puede
 * ser fish o csh: ahí `"\${SHELL:-…}"`, `2>/dev/null` o un salto de línea entre comillas no parsean.
 * Por eso toda línea va como `exec /bin/sh -c '<línea>'`, que esos shells sí entienden. Si la línea
 * tiene algo que csh o fish leerían distinto aun entre comillas simples (salto de línea, `!`, `\`,
 * bytes no ASCII), viaja codificada en octal y la decodifica el `printf` de `/bin/sh`.
 */
export function remoteLine(line: string): string {
  if (PLAIN_LINE.test(line) && !/[!\\]/.test(line)) return `exec /bin/sh -c ${shq(line)}`
  let encoded = ''
  for (const byte of Buffer.from(line, 'utf8')) {
    const ch = String.fromCharCode(byte)
    encoded += byte < 0x80 && PRINTF_LITERAL.test(ch) ? ch : `\\${byte.toString(8).padStart(3, '0')}`
  }
  return `exec /bin/sh -c 'c=$(printf "$1"); shift; eval "$c"' omni '${encoded}'`
}
