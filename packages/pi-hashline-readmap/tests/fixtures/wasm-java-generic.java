package com.example.generic;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

public class Box<T> {
    private T value;

    public Box(T value) {
        this.value = value;
    }

    public T get() {
        return value;
    }

    public <R> Box<R> map(java.util.function.Function<T, R> fn) {
        return new Box<>(fn.apply(value));
    }
}

interface Repository<K, V extends Comparable<V>> {
    Optional<V> find(K key);

    void save(K key, V value);

    <R> List<R> projectAll(java.util.function.Function<V, R> fn);
}

record Pair<A, B>(A first, B second) {
    public <C> Pair<A, C> withSecond(C value) {
        return new Pair<>(first, value);
    }
}

class Container<T extends Number & Comparable<T>> {
    private final List<T> items = new ArrayList<>();

    public void add(T item) {
        items.add(item);
    }

    public T max() {
        T best = items.get(0);
        for (T item : items) {
            if (item.compareTo(best) > 0) {
                best = item;
            }
        }
        return best;
    }
}
