# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

## Improvements

- **Autonomous execution checkpoints** — Agent turns now batch routine discovery, reserve verification capacity before mutations, continue cost checkpoints automatically, and hand completed work to review without overwriting an explicit workflow status.

## Bug Fixes

- **Provider and session recovery** — Mid-stream quota and availability failures now switch to another configured connection, while stale portable long-response paths and false terminal “continue next turn” responses are repaired automatically.

## Breaking Changes
