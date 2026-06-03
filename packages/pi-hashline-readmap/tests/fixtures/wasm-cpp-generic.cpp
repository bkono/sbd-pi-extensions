#include <vector>
#include <string>

template <typename T>
T identity(T value) {
    return value;
}

template <typename A, typename B>
struct Pair {
    A first;
    B second;
};

template <typename T>
class Box {
public:
    explicit Box(T value);
    T get() const;

private:
    T value_;
};

template <typename T>
Box<T>::Box(T value) : value_(value) {}

template <typename T>
T Box<T>::get() const {
    return value_;
}

template <>
class Box<bool> {
public:
    explicit Box(bool value) : value_(value) {}
    bool get() const { return value_; }

private:
    bool value_;
};

template <typename T>
using Vec = std::vector<T>;

typedef Pair<int, int> IntPair;
