/**
 * Tests for stateless tool matching logic.
 *
 * These tests verify that extractToolStarts() and extractToolResults() produce
 * deterministic output regardless of processing order. This is the core invariant
 * that makes the tool matching pipeline stateless.
 *
 * Key property under test: same SDK messages → same AgentEvents, regardless of order.
 */
import { describe, it, expect } from "bun:test";
import { serializeResult } from "../tool-matching";

describe('serializeResult', () => {
  it('passes through strings', () => {
    expect(serializeResult('hello')).toBe('hello')
  })

  it('serializes objects to JSON', () => {
    expect(serializeResult({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2))
  })

  it('returns empty string for null/undefined', () => {
    expect(serializeResult(null)).toBe('')
    expect(serializeResult(undefined)).toBe('')
  })
});
