using System;

namespace TestApp
{
    public class Example
    {
        public string Name { get; set; }
        public int Age { get; set; }

        public Example(string name, int age)
        {
            Name = name;
            Age = age;
        }

        public string GetInfo()
        {
            return Name + " is " + Age + " years old.";
        }
    }
}
