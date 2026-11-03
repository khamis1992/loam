import { describe, expect, it } from 'vitest';
import { FONT_SIZE_STEPS, normalizeCssColor, normalizeFontSizes, serializeEditor, splitMarker } from '../serialize';

function rootOf(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('serialize style whitelist', () => {
  it('keeps a hex background-color and drops any other spelling', () => {
    const html = serializeEditor(rootOf(
      '<p><span style="background-color:#ffff00">a</span>'
      + '<span style="background-color:red">b</span>'
      + '<span style="background-color:linear-gradient(red,blue)">c</span></p>',
    ));
    expect(html).toContain('background-color:#ffff00');
    expect(html).not.toContain('background-color:red');
    expect(html).not.toContain('gradient');
    // the unhighlighted spans keep their text
    expect(html).toBe('<p><span style="background-color:#ffff00">a</span><span>b</span><span>c</span></p>');
  });

  it('normalizes rgb()/rgba()/#rgb colors to #rrggbb', () => {
    const html = serializeEditor(rootOf(
      '<p><span style="background-color: rgb(255, 0, 255)">a</span>'
      + '<span style="background-color: rgba(255,0,0,0.5)">b</span>'
      + '<span style="color: rgb(255, 0, 0)">c</span>'
      + '<span style="color:#f00">d</span>'
      + '<span style="color:red">e</span></p>',
    ));
    expect(html).toContain('background-color:#ff00ff');
    expect(html).not.toContain('rgba(');
    expect(html).toContain('color:#ff0000');
    expect(html).toContain('color:#ff0000');
    // legacy named colors keep their verbatim pass-through
    expect(html).toContain('color:red');
  });

  it('normalizes css color values directly', () => {
    expect(normalizeCssColor('#FFFF00')).toBe('#ffff00');
    expect(normalizeCssColor('#f00')).toBe('#ff0000');
    expect(normalizeCssColor('rgb(1,2,3)')).toBe('#010203');
    expect(normalizeCssColor('rgba(1,2,3,1)')).toBe('#010203');
    expect(normalizeCssColor('rgba(1,2,3,0.5)')).toBeNull();
    expect(normalizeCssColor('red')).toBeNull();
    expect(normalizeCssColor('rgb(300,0,0)')).toBeNull();
  });

  it('still keeps the pre-existing style properties and escapes nothing new', () => {
    const html = serializeEditor(rootOf('<p style="font-family:Tahoma;font-size:14px;text-align:center">x</p>'));
    expect(html).toContain('font-family:Tahoma');
    expect(html).toContain('font-size:14px');
    expect(html).toContain('text-align:center');
  });
});

describe('font[size] normalization', () => {
  it('maps the execCommand 1-7 scale onto px spans with the fixed steps', () => {
    expect(FONT_SIZE_STEPS).toEqual({ '1': 8, '2': 10, '3': 12, '4': 14, '5': 18, '6': 24, '7': 32 });
    const root = rootOf('<p><font size="3">a</font><font size="7">b</font></p>');
    normalizeFontSizes(root);
    expect(root.innerHTML).toBe('<p><span style="font-size: 12px">a</span><span style="font-size: 32px">b</span></p>');
  });

  it('lets the toolbar redirect the just-applied size 7 to any px value', () => {
    const root = rootOf('<p>a<font size="7">big</font></p>');
    normalizeFontSizes(root, 48);
    expect(root.innerHTML).toBe('<p>a<span style="font-size: 48px">big</span></p>');
  });

  it('unwraps unknown size attributes while keeping the text', () => {
    const root = rootOf('<p><font size="9">a<i>b</i></font></p>');
    normalizeFontSizes(root);
    expect(root.innerHTML).toBe('<p><span>a<i>b</i></span></p>');
  });

  it('serializeEditor rewrites stray font[size] markup so the whitelist survives', () => {
    const html = serializeEditor(rootOf('<p><font size="5">hi</font></p>'));
    expect(html).toBe('<p><span style="font-size:18px">hi</span></p>');
  });
});

describe('splitMarker', () => {
  it('splits the marker header from the body', () => {
    const { marker, fragment } = splitMarker('<!-- doc-session abc-123 456 -->\n<p>body</p>');
    expect(marker).toBe('<!-- doc-session abc-123 456 -->');
    expect(fragment).toBe('<p>body</p>');
  });
});
