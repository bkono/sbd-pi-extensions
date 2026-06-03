// Simple Rust fixture for WASM mapper snapshots.

pub const MAX_ITEMS: usize = 16;

pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

pub fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

pub struct Point {
    pub x: f64,
    pub y: f64,
}

pub enum Direction {
    North,
    South,
    East,
    West,
}
