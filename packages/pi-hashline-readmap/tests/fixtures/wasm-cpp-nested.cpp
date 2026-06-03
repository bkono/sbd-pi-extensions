#include <string>
#include <vector>

namespace outer {

class Container {
public:
    Container();
    ~Container();

    void add(int value);
    int size() const;

private:
    struct Node {
        int value;
        Node* next;
    };

    Node* head_;
    int count_;
};

Container::Container() : head_(nullptr), count_(0) {}
Container::~Container() {}

void Container::add(int value) {
    count_++;
}

int Container::size() const {
    return count_;
}

namespace inner {

class Helper {
public:
    static std::string format(int value);

protected:
    int helperValue_;
};

std::string Helper::format(int value) {
    return std::to_string(value);
}

}  // namespace inner

}  // namespace outer
