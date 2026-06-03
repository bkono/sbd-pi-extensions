package com.example.nested;

import java.util.ArrayList;
import java.util.List;

public class Outer {
    private static int instanceCount;

    static {
        instanceCount = 0;
    }

    private final List<Inner> children = new ArrayList<>();

    public Outer() {
        instanceCount++;
    }

    public Inner createChild(String name) {
        Inner child = new Inner(name);
        children.add(child);
        return child;
    }

    public static int instanceCount() {
        return instanceCount;
    }

    public static class Inner {
        private final String name;

        public Inner(String name) {
            this.name = name;
        }

        public String getName() {
            return name;
        }

        public record Coord(int x, int y) {}
    }

    public interface Listener {
        void onEvent(String event);
    }

    public enum Mode {
        FAST,
        SLOW;

        public boolean isFast() {
            return this == FAST;
        }
    }
}
