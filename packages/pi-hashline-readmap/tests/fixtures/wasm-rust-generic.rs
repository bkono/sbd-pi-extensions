// Generic structs, traits, impls, and functions.

use std::fmt::Debug;

pub struct Container<T> {
    pub items: Vec<T>,
}

impl<T: Clone> Container<T> {
    pub fn new() -> Self {
        Self { items: Vec::new() }
    }

    pub fn push(&mut self, item: T) {
        self.items.push(item);
    }

    pub fn first(&self) -> Option<T> {
        self.items.first().cloned()
    }
}

pub trait Reducible<T, U> {
    fn reduce(&self, init: U, f: impl Fn(U, &T) -> U) -> U;
}

impl<T> Reducible<T, usize> for Container<T> {
    fn reduce(&self, init: usize, f: impl Fn(usize, &T) -> usize) -> usize {
        let mut acc = init;
        for item in &self.items {
            acc = f(acc, item);
        }
        acc
    }
}

pub fn longest<'a, T: PartialOrd>(a: &'a T, b: &'a T) -> &'a T {
    if a > b { a } else { b }
}

pub fn print_all<T: Debug>(items: &[T]) {
    for item in items {
        println!("{:?}", item);
    }
}

pub struct Pair<A, B> {
    pub first: A,
    pub second: B,
}
