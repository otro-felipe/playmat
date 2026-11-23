import { describe, expect, test } from 'vitest';
import { chatText } from './chatText';
import { toChatLines } from './chatLine';
import { parseChatMessage } from '../game/gameLog';
import { decodeEntities } from '../game/entities';

const examples = [
  ['  Mi texto &amp;amp; 🌿\n\n' + 'Hola '.repeat(35) + 'Último 🦊.  ', '  Mi texto &amp; 🌿\n\n' + 'Hola '.repeat(35) + 'Último 🦊.  '],
  ['Ahora s&iacute;, revancha sin regalar turnos 😈 Suerte, Felipe.', 'Ahora sí, revancha sin regalar turnos 😈 Suerte, Felipe.'],
  ['La nutria ya lleg&oacute; a la oficina. Hoy s&iacute; 😄', 'La nutria ya llegó a la oficina. Hoy sí 😄'],
  ['El &uacute;nico objetivo tambi&eacute;n deja sin resolver Learn.', 'El único objetivo también deja sin resolver Learn.'],
  ['3/3 con 2 da&ntilde;os. Ese +1/+1 extra s&iacute; importa.', '3/3 con 2 daños. Ese +1/+1 extra sí importa.'],
  ['Mutavault s&iacute; cuenta como Demon. Ah&iacute; pude cambiar Burst.', 'Mutavault sí cuenta como Demon. Ahí pude cambiar Burst.'],
  ['ÁÉÍÓÚ Ü Ñ áéíóú ü ñ 🦝😈', 'ÁÉÍÓÚ Ü Ñ áéíóú ü ñ 🦝😈'],
  ['&Aacute;&Eacute;&Iacute;&Oacute;&Uacute; &Uuml; &Ntilde;', 'ÁÉÍÓÚ Ü Ñ'],
  ['&ldquo;S&iacute;&rdquo; &lsquo;hola&rsquo; &apos;literal&apos;', '“Sí” ‘hola’ \'literal\''],
  ['Sí 🧑🏽‍💻 “Unicode” 👨‍👩‍👧‍👦', 'Sí 🧑🏽‍💻 “Unicode” 👨‍👩‍👧‍👦'],
  ['&#x41;hora&#x20;s&#237; &#x1F608; &#129437;', 'Ahora sí 😈 🦝'],
  ['&amp;iacute; &amp;#237; &amp;#xED;', '&iacute; &#237; &#xED;'],
  ['&amp;amp;iacute; &amp;lt;script&amp;gt;', '&amp;iacute; &lt;script&gt;'],
  ['&lt;b&gt;s&iacute;&lt;/b&gt; [abc] {G}', '<b>sí</b> [abc] {G}'],
  ['&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;alert(2)&lt;/script&gt;', '<img src=x onerror=alert(1)><script>alert(2)</script>'],
  ['Tom &amp; Jerry &lt; 3; R&D', 'Tom & Jerry < 3; R&D'],
];

describe.each(['TALK', 'WHISPER_FROM', 'WHISPER_TO'] as const)('%s text contract', (messageType) => {
  test.each(examples)('decodes exactly one wire escape: %s', (wire, expected) => {
    expect(chatText(wire)).toBe(expected);
    const message = { messageType, username: 'Rakún', message: wire };
    expect(toChatLines(message, 'room')[0]).toMatchObject({ who: 'Rakún', text: expected, segments: [{ kind: 'text', text: expected }] });
    expect(parseChatMessage(message, 'game')).toMatchObject({ tone: 'chat', who: 'Rakún', text: expected, segments: [{ kind: 'text', text: expected }] });
  });
});

test('HTML 4 entity names preserve case and digits; invalid or unknown references stay literal', () => {
  expect(decodeEntities('&Agrave; &agrave; &OElig; &oelig; &frac12; &AMP;')).toBe('À à Œ œ ½ &');
  expect(decodeEntities('&madeup; &#x110000; &#xD800; &#0; &#xZZ;')).toBe('&madeup; &#x110000; &#xD800; &#0; &#xZZ;');
});

test('object prototype names are not named character references', () => {
  const text = '&constructor; &toString; &hasOwnProperty;';
  expect(decodeEntities(text)).toBe(text);
  expect(chatText(text)).toBe(text);
});

test('only server notices and game logs interpret transport markup as formatting', () => {
  expect(toChatLines({ messageType: 'USER_INFO', message: '<b>S&iacute;</b><br>lleg&oacute;' }, 'notice').map((line) => line.text)).toEqual(['Sí', 'llegó']);
  expect(chatText('<b>sí</b>')).toBe('<b>sí</b>');
});
