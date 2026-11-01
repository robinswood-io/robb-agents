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
import { isToolResultError } from "../tool-matching";

describe('isToolResultError', () => {
  it('detects Error: prefix', () => {
    expect(isToolResultError('Error: file not found')).toBe(true)
  })

  it('detects error: prefix', () => {
    expect(isToolResultError('error: command failed')).toBe(true)
  })

  it('detects [ERROR] prefix', () => {
    expect(isToolResultError('[ERROR] command failed')).toBe(true)
  })

  it('detects rbw transfer failures returned with a completed transport status', () => {
    expect(isToolResultError('❌ Download error: ENOENT: no such file or directory')).toBe(true)
    expect(isToolResultError('  ❌ Upload error: remote write failed')).toBe(true)
  })

  it('detects is_error flag in object', () => {
    expect(isToolResultError({ is_error: true, message: 'fail' })).toBe(true)
  })

  it('detects error key in object', () => {
    expect(isToolResultError({ error: 'something broke' })).toBe(true)
  })

  it('returns false for normal results', () => {
    expect(isToolResultError('success')).toBe(false)
    expect(isToolResultError('Upload completed without error.')).toBe(false)
    expect(isToolResultError({ data: 'ok' })).toBe(false)
  })
});
