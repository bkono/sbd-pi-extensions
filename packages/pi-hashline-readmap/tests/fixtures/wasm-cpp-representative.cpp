#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace service {

constexpr int kDefaultTimeoutMs = 5000;
constexpr const char* kServiceName = "users";

using UserId = std::int64_t;

enum class Role {
    Guest,
    Member,
    Admin,
};

struct User {
    UserId id;
    std::string name;
    Role role;
};

class NotFoundError : public std::runtime_error {
public:
    explicit NotFoundError(const std::string& what)
        : std::runtime_error(what) {}
};

template <typename T>
class Repository {
public:
    virtual ~Repository() = default;
    virtual std::optional<T> find(UserId id) const = 0;
    virtual void save(const T& entity) = 0;
    virtual std::vector<T> list() const = 0;
};

class InMemoryUserRepository : public Repository<User> {
public:
    InMemoryUserRepository();
    ~InMemoryUserRepository() override;

    std::optional<User> find(UserId id) const override;
    void save(const User& entity) override;
    std::vector<User> list() const override;

private:
    std::unordered_map<UserId, User> users_;
};

InMemoryUserRepository::InMemoryUserRepository() = default;
InMemoryUserRepository::~InMemoryUserRepository() = default;

std::optional<User> InMemoryUserRepository::find(UserId id) const {
    auto it = users_.find(id);
    if (it == users_.end()) {
        return std::nullopt;
    }
    return it->second;
}

void InMemoryUserRepository::save(const User& entity) {
    users_[entity.id] = entity;
}

std::vector<User> InMemoryUserRepository::list() const {
    std::vector<User> result;
    result.reserve(users_.size());
    for (const auto& entry : users_) {
        result.push_back(entry.second);
    }
    return result;
}

template <typename Repo>
class UserService {
public:
    explicit UserService(std::shared_ptr<Repo> repo);

    User register_user(const std::string& name, Role role);
    User promote(UserId id);
    std::vector<User> all() const;

private:
    UserId next_id();

    std::shared_ptr<Repo> repo_;
    UserId next_id_;
};

template <typename Repo>
UserService<Repo>::UserService(std::shared_ptr<Repo> repo)
    : repo_(std::move(repo)), next_id_(1) {}

template <typename Repo>
User UserService<Repo>::register_user(const std::string& name, Role role) {
    User user{next_id(), name, role};
    repo_->save(user);
    return user;
}

template <typename Repo>
User UserService<Repo>::promote(UserId id) {
    auto existing = repo_->find(id);
    if (!existing) {
        throw NotFoundError("user not found");
    }
    User updated = *existing;
    updated.role = Role::Admin;
    repo_->save(updated);
    return updated;
}

template <typename Repo>
std::vector<User> UserService<Repo>::all() const {
    return repo_->list();
}

template <typename Repo>
UserId UserService<Repo>::next_id() {
    return next_id_++;
}

namespace util {

std::string role_to_string(Role role) {
    switch (role) {
        case Role::Guest:
            return "guest";
        case Role::Member:
            return "member";
        case Role::Admin:
            return "admin";
    }
    return "unknown";
}

using UserMap = std::unordered_map<UserId, User>;
typedef std::vector<User> UserList;

}  // namespace util

}  // namespace service
