import assert from 'node:assert';
import { describe, it } from 'node:test';
import { parseBulletChartData, parseBulletDiagram } from '../slide-chart-data.js';
import { StudioError } from '../store.js';

describe('parseBulletChartData', () => {
  it('maps label:value bullets to one series with categories', () => {
    const chart = parseBulletChartData(['Apples: 3', 'Pears: 5', 'Plums: 2']);
    assert.strictEqual(chart.kind, 'bar');
    assert.deepStrictEqual(chart.categories, ['Apples', 'Pears', 'Plums']);
    assert.strictEqual(chart.series.length, 1);
    assert.deepStrictEqual(chart.series[0]!.values, [3, 5, 2]);
    assert.strictEqual(chart.series[0]!.name, 'Values');
  });
  it('accepts a multiline string with markers, percents and a type directive', () => {
    const chart = parseBulletChartData('type: line\nTitle: Revenue\nQ1: 10%\nQ2: 20');
    assert.strictEqual(chart.kind, 'line');
    assert.strictEqual(chart.title, 'Revenue');
    assert.deepStrictEqual(chart.categories, ['Q1', 'Q2']);
    assert.deepStrictEqual(chart.series[0]!.values, [10, 20]);
  });
  it('treats multi-value bullets as series over an explicit category row', () => {
    const chart = parseBulletChartData(['Categories: q1, q2, q3', 'Ads: 1, 2, 3', 'Organic: 4, 5, 6']);
    assert.deepStrictEqual(chart.categories, ['q1', 'q2', 'q3']);
    assert.strictEqual(chart.series.length, 2);
    assert.deepStrictEqual(chart.series[1]!.values, [4, 5, 6]);
  });
  it('supports numbered list markers and positional default categories', () => {
    const chart = parseBulletChartData(['1) Alpha: 1, 2', '2. Beta: 3, 4']);
    assert.deepStrictEqual(chart.categories, ['1', '2']);
    assert.deepStrictEqual(chart.series.map((s) => s.name), ['Alpha', 'Beta']);
  });
  it('validates input', () => {
    assert.throws(() => parseBulletChartData([]), StudioError);
    assert.throws(() => parseBulletChartData(['Apples: red']), StudioError);
    assert.throws(() => parseBulletChartData(['A: 1, 2', 'B: 3']), StudioError);
    assert.throws(() => parseBulletChartData(['Categories: x, y', 'A: 1']), StudioError);
    assert.throws(() => parseBulletChartData(['A: 1', 'Title: one', 'Title: two']), StudioError);
    assert.throws(() => parseBulletChartData(['A: 1', 'A: 2', 'B: 5']), StudioError);
    assert.throws(() => parseBulletChartData(['A: 1, 2', 'B: 3, 4'], { kind: 'pie' }), StudioError);
    assert.throws(() => parseBulletChartData('Title: only'), StudioError);
    assert.throws(() => parseBulletChartData(['A: 1'], { kind: 'sparkle' as never }), StudioError);
    assert.throws(() => parseBulletChartData(42 as never), StudioError);
  });
  it('keeps negative and decimal values', () => {
    const chart = parseBulletChartData(['Loss: -2.5', 'Gain: 1.25']);
    assert.deepStrictEqual(chart.series[0]!.values, [-2.5, 1.25]);
  });
});

describe('parseBulletDiagram', () => {
  it('builds a sequential flow from plain bullets', () => {
    const diagram = parseBulletDiagram(['Gather ideas', 'Draft outline', 'Present']);
    assert.strictEqual(diagram.layout, 'sequential');
    assert.deepStrictEqual(diagram.nodes.map((n) => n.label), ['Gather ideas', 'Draft outline', 'Present']);
    assert.deepStrictEqual(diagram.edges, [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }]);
  });
  it('parses arrow lines into a deduplicated flow graph', () => {
    const diagram = parseBulletDiagram(['Start -> Review', 'Review -> Ship', 'Start -> Ship']);
    assert.strictEqual(diagram.layout, 'flow');
    assert.strictEqual(diagram.nodes.length, 3);
    assert.deepStrictEqual(diagram.edges, [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n1', to: 'n3' }]);
  });
  it('supports chained arrows and unicode arrows', () => {
    const diagram = parseBulletDiagram(['A → B → C']);
    assert.strictEqual(diagram.nodes.length, 3);
    assert.deepStrictEqual(diagram.edges, [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }]);
  });
  it('builds a hierarchy from indentation', () => {
    const diagram = parseBulletDiagram(['Title: Org', 'Team', '  Alice', '  Bob', 'Other team']);
    assert.strictEqual(diagram.title, 'Org');
    assert.strictEqual(diagram.layout, 'hierarchy');
    assert.strictEqual(diagram.nodes.length, 4);
    assert.deepStrictEqual(diagram.edges, [
      { from: 'n1', to: 'n2' },
      { from: 'n1', to: 'n3' },
    ]);
  });
  it('validates input', () => {
    assert.throws(() => parseBulletDiagram(['  ']), StudioError);
    assert.throws(() => parseBulletDiagram(['Title: x']), StudioError);
    assert.throws(() => parseBulletDiagram(['Title: one', 'Title: two']), StudioError);
    assert.throws(() => parseBulletDiagram(Array.from({ length: 61 }, (_, i) => `Step ${i}`)), StudioError);
  });
});
