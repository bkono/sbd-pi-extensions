#include <string>

constexpr int kMaxItems = 100;

int add(int a, int b) {
    return a + b;
}

double scale(double value, double factor) {
    return value * factor;
}

struct Point {
    int x;
    int y;
};

enum class Color {
    Red,
    Green,
    Blue,
};

std::string greet(const std::string& name) {
    return "hello " + name;
}
