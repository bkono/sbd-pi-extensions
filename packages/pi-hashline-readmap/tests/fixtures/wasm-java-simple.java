package com.example.simple;

import java.util.List;
import java.util.Objects;

public class Greeter {
    private final String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet() {
        return "hello " + name;
    }

    public static String shout(String text) {
        return text.toUpperCase();
    }
}

interface Named {
    String getName();
}

enum Color {
    RED,
    GREEN,
    BLUE;
}
