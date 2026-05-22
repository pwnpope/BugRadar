export const bugClasses = [
  "SQL Injection",
  "Command Injection",
  "Path Traversal",
  "Unsafe Deserialization",
  "Cross-Site Scripting",
  "SSRF",
  "Integer Overflow",
  "Pointer Underflow",
  "Out-of-Bounds Read",
  "Out-of-Bounds Write",
  "Use-After-Free",
  "Race Condition",
  "Stack Buffer Overflow",
  "Heap Overflow",
  "Use of Uninitialized Memory",
  "Double Free",
  "Format String",
  "Logic/Authorization",
  "Cryptographic Misuse",
  "Chained Vulnerability"
];

export const languages = [
  "PHP",
  "Python",
  "C",
  "C++",
  "Rust",
  "Assembly x86",
  "Assembly ARM"
];

export const difficulties = ["easy", "medium", "hard", "extreme"];

export const providers = [
  { id: "codex", label: "Codex CLI" },
  { id: "claude", label: "Claude CLI" }
];
